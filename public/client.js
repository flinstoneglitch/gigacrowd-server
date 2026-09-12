// GigaCrowd mobile/web client — mic capture, RMS telemetry, and cheer-spike upload.
// Talks to server.js over Socket.IO: emits 'mic-telemetry' ({ volume: 0-100 })
// and 'user-cheer-clip' ({ audioData: base64 raw Float32 PCM }) which master.html consumes.

const socket = io();

const startBtn = document.getElementById('start-btn');
const statusEl = document.getElementById('status');
const meterFill = document.getElementById('meter-fill');

// --- Tunables ---
const TELEMETRY_INTERVAL_MS = 100;   // how often we send volume updates
const CHEER_VOLUME_THRESHOLD = 65;   // 0-100 scale; crossing this fires a cheer clip
const CHEER_COOLDOWN_MS = 1500;      // minimum gap between cheer uploads
const CHEER_CLIP_SECONDS = 1;        // length of the rolling buffer we upload

let audioCtx, analyser, processor, mediaStream;
let timeDomainData;
let ringBuffer, ringLength, ringWriteIndex = 0, ringFilled = false;
let telemetryTimer = null;
let lastCheerAt = 0;
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

function float32ToBase64(float32Array) {
  const bytes = new Uint8Array(float32Array.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return window.btoa(binary);
}

function sendCheerClip() {
  const ordered = new Float32Array(ringLength);
  if (ringFilled) {
    // Ring buffer has wrapped: oldest sample is at ringWriteIndex.
    ordered.set(ringBuffer.subarray(ringWriteIndex));
    ordered.set(ringBuffer.subarray(0, ringWriteIndex), ringLength - ringWriteIndex);
  } else {
    ordered.set(ringBuffer.subarray(0, ringWriteIndex));
  }

  socket.emit('user-cheer-clip', { audioData: float32ToBase64(ordered) });
}

function handleAudioProcess(event) {
  const input = event.inputBuffer.getChannelData(0);

  // Write into the ring buffer.
  for (let i = 0; i < input.length; i++) {
    ringBuffer[ringWriteIndex] = input[i];
    ringWriteIndex++;
    if (ringWriteIndex >= ringLength) {
      ringWriteIndex = 0;
      ringFilled = true;
    }
  }
}

function tick() {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(timeDomainData);
  const rms = computeRMS(timeDomainData);
  const volume = Math.min(100, Math.round(rms * 400)); // scale mic RMS (~0-0.25) up to 0-100

  setMeter(volume);
  socket.emit('mic-telemetry', { volume });

  const now = Date.now();
  if (volume >= CHEER_VOLUME_THRESHOLD && now - lastCheerAt >= CHEER_COOLDOWN_MS) {
    lastCheerAt = now;
    setStatus('[ CHEER SENT! ]', '#ff0055');
    sendCheerClip();
    setTimeout(() => {
      if (listening) setStatus('[ LIVE — KEEP ROARING ]', '#00ffcc');
    }, 400);
  }
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

  // Rolling ~1s raw-sample buffer, fed continuously, so a cheer spike can be
  // uploaded from the audio that just happened (not audio captured after the fact).
  ringLength = Math.round(audioCtx.sampleRate * CHEER_CLIP_SECONDS);
  ringBuffer = new Float32Array(ringLength);
  ringWriteIndex = 0;
  ringFilled = false;

  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = handleAudioProcess;
  source.connect(processor);
  // Route to a muted destination so the graph stays alive without audible playback.
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;
  processor.connect(silentGain);
  silentGain.connect(audioCtx.destination);

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
