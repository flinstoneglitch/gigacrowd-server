const express = require('express');
const http = require('http');
const path = require('path');
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

let connectedClients = 0;

// Per-client volume state. The overlay's "crowd energy" is meant to represent
// everyone's excitement together, so it's aggregated (averaged) across every
// connected client rather than just reflecting whichever telemetry packet
// happened to arrive most recently.
const clientVolumes = new Map(); // socket.id -> last reported volume (0-100)
const BROADCAST_INTERVAL_MS = 150;

function currentCrowdEnergy() {
  if (clientVolumes.size === 0) return 0;
  let sum = 0;
  for (const volume of clientVolumes.values()) sum += volume;
  return Math.round(sum / clientVolumes.size);
}

io.on('connection', (socket) => {
  connectedClients++;
  console.log(`[GigaCrowd] Client joined. Active crowd size: ${connectedClients}`);

  // Handle live volume telemetry. v1 deliberately never receives or relays
  // recorded audio — only this anonymous numeric level, aggregated below.
  socket.on('mic-telemetry', (data) => {
    const volume = Math.min(100, Math.max(0, Number(data && data.volume) || 0));
    clientVolumes.set(socket.id, volume);
  });

  socket.on('disconnect', () => {
    connectedClients = Math.max(0, connectedClients - 1);
    clientVolumes.delete(socket.id);
    console.log(`[GigaCrowd] Client left. Active crowd size: ${connectedClients}`);
  });
});

// Broadcast the aggregated crowd energy on a fixed tick rather than once per
// telemetry packet — this decouples the overlay's update rate from how many
// phones are connected or how often each one reports, so it stays smooth
// (and doesn't flood every listener) whether there are 2 clients or 2,000.
setInterval(() => {
  io.emit('crowdEnergy', {
    totalEnergy: currentCrowdEnergy(),
    clientCount: connectedClients
  });
}, BROADCAST_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⚡ GigaCrowd server active on http://localhost:${PORT}`);
});
