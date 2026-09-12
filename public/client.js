// GigaCrowd mobile/web client — show join gate, mic capture, and RMS volume
// telemetry.
// Talks to server.js over Socket.IO: joins a show room by code (via a
// ?room= link/QR scan or manual entry), then emits 'mic-telemetry'
// ({ volume: 0-100 }) scoped to that room.
//
// v1 deliberately never records or uploads audio — only an anonymous numeric
// volume level leaves the phone. No raw/recorded voice is captured, stored,
// or broadcast to other users. (An earlier version prototyped uploading
// short cheer-clip recordings; that's been removed for v1 to avoid shipping
// unmoderated user-generated audio — see the "cheer clips" note in project
// planning for the moderation work that would need to land before that
// feature could come back.)

const socket = io(window.GIGACROWD_SERVER_URL);

const joinGate = document.getElementById('join-gate');
const joinForm = document.getElementById('join-form');
const roomInput = document.getElementById('room-input');
const joinError = document.getElementById('join-error');

const roarGate = document.getElementById('roar-gate');
const startBtn = document.getElementById('start-btn');
const statusEl = document.getElementById('status');
const meterFill = document.getElementById('meter-fill');

const TELEMETRY_INTERVAL_MS = 100; // how often we send volume updates

let audioCtx, analyser, mediaStream;
let timeDomainData;
let telemetryTimer = null;
let listening = false;
let joinedRoomId = null;

function setStatus(text, color) {
  if (!statusEl) return;
  statusEl.innerText = text;
  if (color) statusEl.style.color = color;
}

function setMeter(percent) {
  if (!meterFill) return;
  meterFill.style.width = Math.max(0, Math.min(100, percent)) + '%';
}

function computeRMS(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / buffer.length);
}

function tick() {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(timeDomainData);
  const rms = computeRMS(timeDomainData);
  const volume = Math.min(100, Math.round(rms * 400)); // scale mic RMS (~0-0.25) up to 0-100

  setMeter(volume);
  socket.emit('mic-telemetry', { volume });
}

async function startListening() {
  if (listening) return;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error('Mic access denied or unavailable:', err);
    setStatus('[ MIC ACCESS DENIED — CHECK PERMISSIONS ]', '#ff0055');
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(mediaStream);

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  timeDomainData = new Float32Array(analyser.fftSize);
  source.connect(analyser);

  listening = true;
  startBtn.innerText = 'ROARING...';
  startBtn.disabled = true;
  setStatus(`[ LIVE IN SHOW ${joinedRoomId} — KEEP ROARING ]`, '#00ffcc');

  telemetryTimer = setInterval(tick, TELEMETRY_INTERVAL_MS);
}

// --- Join gate ---

function attemptJoin(roomId) {
  roomId = (roomId || '').trim().toUpperCase();
  if (!roomId) return;

  joinError.innerText = '[ CONNECTING... ]';
  socket.emit('join-room', { roomId, role: 'fan' }, (res) => {
    if (res && res.ok) {
      joinedRoomId = roomId;
      joinGate.hidden = true;
      roarGate.hidden = false;
      setStatus('[ TAP TO GRANT MIC ACCESS ]');

      // Bake the room into the URL so a reload (or sharing this exact link)
      // rejoins the same show instead of asking again.
      const url = new URL(window.location.href);
      url.searchParams.set('room', roomId);
      window.history.replaceState({}, '', url);
    } else {
      joinError.innerText = (res && res.error) || '[ COULD NOT JOIN — CHECK THE CODE ]';
    }
  });
}

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  attemptJoin(roomInput.value);
});

startBtn.addEventListener('click', startListening);

// --- Native deep linking (iOS Universal Links) ---
// Inside the native app, tapping a https://.../?room=CODE link (e.g. from
// scanning the overlay's QR code) opens this app directly via the
// com.apple.developer.associated-domains entitlement, and Capacitor's App
// plugin fires this event with that URL — the page itself never actually
// navigates there. This has no effect on the plain website (window.Capacitor
// doesn't exist outside the native app), where the ?room= URL param is
// already handled by 'connect' above.
if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
  const CapApp = window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (CapApp && CapApp.addListener) {
    CapApp.addListener('appUrlOpen', (data) => {
      try {
        const roomId = new URL(data.url).searchParams.get('room');
        if (roomId) attemptJoin(roomId);
      } catch (err) {
        console.error('[GigaCrowd] Could not parse incoming deep link:', err);
      }
    });
  }
}

socket.on('connect', () => {
  console.log('[GigaCrowd] Connected to crowd grid.');
  const roomFromUrl = new URLSearchParams(window.location.search).get('room');
  if (roomFromUrl) attemptJoin(roomFromUrl);
});

socket.on('disconnect', () => {
  setStatus('[ DISCONNECTED FROM CROWD GRID ]', '#ff0055');
});
