const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7 // Increase max payload limit for audio buffers
});

app.use(express.static(path.join(__dirname, 'public')));

let connectedClients = 0;
let totalEnergy = 0;

io.on('connection', (socket) => {
  connectedClients++;
  console.log(`[GigaCrowd] Client joined. Active crowd size: ${connectedClients}`);

  // 1. Handle live volume telemetry
  socket.on('mic-telemetry', (data) => {
    totalEnergy = Math.min(100, Math.max(0, data.volume));
    io.emit('crowdEnergy', {
      totalEnergy,
      clientCount: connectedClients
    });
  });

  // 2. Handle real-user voice audio clips on cheer spikes
  socket.on('user-cheer-clip', (data) => {
    console.log(`[GigaCrowd] Received real user cheer clip! Relaying to master overlay...`);
    io.emit('play-cheer-clip', {
      audioData: data.audioData,
      timestamp: Date.now()
    });
  });

  socket.on('disconnect', () => {
    connectedClients = Math.max(0, connectedClients - 1);
    console.log(`[GigaCrowd] Client left. Active crowd size: ${connectedClients}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⚡ GigaCrowd server active on http://localhost:${PORT}`);
});
