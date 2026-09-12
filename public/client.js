// GigaCrowd mobile/web client — mic capture and RMS volume telemetry.
// Talks to server.js over Socket.IO: emits 'mic-telemetry' ({ volume: 0-100 }).
//
// v1 deliberately never records or uploads audio — only an anonymous numeric
// volume level leaves the phone. No raw/recorded voice is captured, stored,
// or broadcast to other users. (An earlier version prototyped uploading
// short cheer-clip recordings; that's been removed for v1 to avoid shipping
// unmoderated user-generated audio — see the "cheer clips" note in project
// planning for the moderation work that would need to land before that
// feature could come back.)

const socket = io();

const startBtn = document.getElementById('start-btn');
const statusEl = document.getElementById('status');
const meterFill = document.getElementById('meter-fill');

const TELEMETRY_INTERVAL_MS = 100; // how often we send volume updates

let audioCtx, analyser, mediaStream;
let timeDomainData;
let telemetryTimer = null;
let listening = false;

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
  setStatus('[ LIVE — KEEP ROARING ]', '#00ffcc');

  telemetryTimer = setInterval(tick, TELEMETRY_INTERVAL_MS);
}

startBtn.addEventListener('click', startListening);

socket.on('connect', () => {
  console.log('[GigaCrowd] Connected to crowd grid.');
});

socket.on('disconnect', () => {
  setStatus('[ DISCONNECTED FROM CROWD GRID ]', '#ff0055');
});
