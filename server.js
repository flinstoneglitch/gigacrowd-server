const express = require('express');
const http = require('http');
const path = require('path');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // The native iOS app bundles its own copy of these pages and loads them
  // from a capacitor://localhost origin, not this server's own origin — so
  // its Socket.IO handshake is cross-origin and gets rejected without this.
  // Web use from this server's own origin also matches an explicit entry
  // (Socket.IO doesn't special-case same-origin once `cors` is configured).
  cors: {
    origin: [
      'capacitor://localhost',
      'http://localhost',
      'https://localhost',
      'https://gigacrowd-server-production.up.railway.app'
    ],
    methods: ['GET', 'POST']
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// --- iOS Universal Links ---
// Lets a QR/join link (https://.../?room=CODE) open directly in the native
// app instead of mobile Safari, when the app is installed. iOS fetches this
// file over HTTPS to verify the app is allowed to claim this domain — it
// must be exact JSON with no redirects, and specifically NOT have a .json
// extension in its URL. TEAM_ID.BUNDLE_ID must match the app's actual
// Apple Developer Team ID and bundle identifier exactly, or iOS silently
// refuses to open the app and just falls through to the browser.
const APPLE_APP_ID = 'Q9DTBX8M85.com.gigacrowd.app';
const appleAppSiteAssociation = {
  applinks: {
    apps: [],
    details: [
      {
        appID: APPLE_APP_ID, // legacy key, older iOS versions
        appIDs: [APPLE_APP_ID], // current key, iOS 13+
        paths: ['*']
      }
    ]
  }
};
app.get(['/.well-known/apple-app-site-association', '/apple-app-site-association'], (req, res) => {
  res.type('application/json').json(appleAppSiteAssociation);
});

// --- Rooms ---
// Each live show is a room: one overlay (master.html, the "master" role) and
// any number of fan phones (index.html, the "fan" role) joined by room code.
// Aggregation and broadcast are scoped per room so multiple shows can run at
// the same time without their crowds bleeding into each other — the earlier
// version had exactly one global crowd shared by every connection, anywhere.
//
// rooms: Map<roomId, { clientVolumes: Map<socketId, volume>, masterSocketId: string|null, closeTimer: Timeout|null, permanent?: true }>
const rooms = new Map();

// A permanent demo room for App Review (Guideline 2.1(a)): reviewers only
// have one device and no way to run an OBS overlay themselves, so a normal
// room — which only exists while a real overlay is connected — is a dead
// end for them. This one is seeded at boot, never expires, and never gets
// torn down by the master-disconnect logic below, so the demo code always
// works: reviewers can join it as a fan from the app, and separately open
// /master.html?room=DEMO in a plain browser tab to see the overlay side
// (the crowd-energy visualizer) without needing OBS at all.
const DEMO_ROOM_ID = 'DEMO';
rooms.set(DEMO_ROOM_ID, { clientVolumes: new Map(), masterSocketId: null, closeTimer: null, permanent: true });
const BROADCAST_INTERVAL_MS = 150;
// A page reload (OBS source refresh, a flaky connection) disconnects the old
// socket before the new one exists — there's no overlap. Without a grace
// period, the old socket's disconnect handler deletes the room an instant
// before the reload's reclaim attempt would have found it. This window gives
// a reconnecting overlay a real chance to reclaim its show instead of the
// disconnect handler nuking it out from under it.
const MASTER_GRACE_PERIOD_MS = 15000;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids ambiguity if read aloud or typed
const ROOM_CODE_LENGTH = 6;

function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
  } while (rooms.has(code)); // vanishingly unlikely to collide, but be certain
  return code;
}

function roomEnergy(room) {
  if (room.clientVolumes.size === 0) return 0;
  let sum = 0;
  for (const volume of room.clientVolumes.values()) sum += volume;
  return Math.round(sum / room.clientVolumes.size);
}

function originFromSocket(socket) {
  const headers = socket.handshake.headers || {};
  if (headers.origin) return headers.origin;
  if (headers.host) return `${socket.handshake.secure ? 'https' : 'http'}://${headers.host}`;
  return 'https://gigacrowd-server-production.up.railway.app';
}

async function buildJoinQr(socket, roomId) {
  const joinUrl = `${originFromSocket(socket)}/?room=${roomId}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, width: 300 });
    return { joinUrl, qrDataUrl };
  } catch (err) {
    console.error('[GigaCrowd] QR generation failed:', err);
    return { joinUrl, qrDataUrl: null };
  }
}

io.on('connection', (socket) => {
  console.log(`[GigaCrowd] Socket connected: ${socket.id}`);

  // The overlay (OBS/Streamlabs/vMix/XSplit) calls this to start a new show
  // and get a room code + QR code fans can scan to join it.
  socket.on('create-room', async (_data, callback) => {
    const roomId = generateRoomCode();
    rooms.set(roomId, { clientVolumes: new Map(), masterSocketId: socket.id, closeTimer: null });
    socket.data.roomId = roomId;
    socket.data.role = 'master';
    socket.join(roomId);

    const { joinUrl, qrDataUrl } = await buildJoinQr(socket, roomId);

    console.log(`[GigaCrowd] Room ${roomId} created by ${socket.id}`);
    if (typeof callback === 'function') {
      callback({ roomId, joinUrl, qrDataUrl });
    }
  });

  // Fans (and a reloaded overlay recovering its own show) call this with an
  // existing room code.
  socket.on('join-room', async (data, callback) => {
    const roomId = String((data && data.roomId) || '').toUpperCase();
    const role = data && data.role === 'master' ? 'master' : 'fan';
    const room = rooms.get(roomId);

    if (!room) {
      if (typeof callback === 'function') callback({ ok: false, error: 'Show not found. Check the code and try again.' });
      return;
    }

    socket.data.roomId = roomId;
    socket.data.role = role;
    socket.join(roomId);

    if (role === 'master') {
      // An overlay reconnecting (e.g. OBS source reloaded) reclaims its show
      // rather than orphaning it. Cancel any pending close from the old
      // socket's disconnect so this reclaim isn't immediately undone by it.
      if (room.closeTimer) {
        clearTimeout(room.closeTimer);
        room.closeTimer = null;
      }
      room.masterSocketId = socket.id;
    } else {
      console.log(`[GigaCrowd] Fan ${socket.id} joined room ${roomId}`);
    }

    if (typeof callback === 'function') {
      if (role === 'master') {
        // Regenerate the QR too, not just the code — a reclaimed overlay
        // (page reload) needs a real image, not a broken <img> left over
        // from a response that only had the earlier create-room's data.
        const { joinUrl, qrDataUrl } = await buildJoinQr(socket, roomId);
        callback({ ok: true, roomId, joinUrl, qrDataUrl, clientCount: room.clientVolumes.size });
      } else {
        callback({ ok: true, roomId, clientCount: room.clientVolumes.size });
      }
    }
  });

  // Handle live volume telemetry. v1 deliberately never receives or relays
  // recorded audio — only this anonymous numeric level, aggregated below.
  socket.on('mic-telemetry', (data) => {
    const roomId = socket.data.roomId;
    if (!roomId) return; // never joined a room — nothing to attribute this to
    const room = rooms.get(roomId);
    if (!room) return;

    const volume = Math.min(100, Math.max(0, Number(data && data.volume) || 0));
    room.clientVolumes.set(socket.id, volume);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    room.clientVolumes.delete(socket.id);

    if (room.permanent) {
      // Never torn down — just clear the master slot so a future overlay
      // connection (or another reviewer) can claim it fresh.
      if (socket.data.role === 'master' && room.masterSocketId === socket.id) {
        room.masterSocketId = null;
      }
    } else if (socket.data.role === 'master' && room.masterSocketId === socket.id) {
      // Don't tear the room down immediately — give a reconnecting overlay
      // (page reload, brief network drop) a grace window to reclaim it via
      // join-room before treating the show as actually over.
      console.log(`[GigaCrowd] Master for room ${roomId} disconnected — closing in ${MASTER_GRACE_PERIOD_MS}ms unless reclaimed`);
      room.closeTimer = setTimeout(() => {
        // Only close if nothing reclaimed it in the meantime.
        if (room.masterSocketId === socket.id) {
          rooms.delete(roomId);
          console.log(`[GigaCrowd] Room ${roomId} closed (overlay did not reconnect)`);
        }
      }, MASTER_GRACE_PERIOD_MS);
    } else {
      console.log(`[GigaCrowd] Fan ${socket.id} left room ${roomId}`);
    }
  });
});

// Broadcast each room's aggregated crowd energy on a fixed tick rather than
// once per telemetry packet — this decouples update rate from how many
// phones are in a room or how often each one reports.
setInterval(() => {
  for (const [roomId, room] of rooms) {
    io.to(roomId).emit('crowdEnergy', {
      totalEnergy: roomEnergy(room),
      clientCount: room.clientVolumes.size
    });
  }
}, BROADCAST_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⚡ GigaCrowd server active on http://localhost:${PORT}`);
});
