const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  pingInterval: 20000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6,
  cors: { origin: true, credentials: true },
});

const PORT = Number(process.env.PORT || 3000);
const APP_NAME = process.env.APP_NAME || 'RaiCord';
const DEFAULT_CHANNELS = ['geral', 'gaming', 'musica', 'privado'];

const rooms = new Map(); // roomId -> Map(socket.id, user)
const history = new Map(); // roomId -> message[]

function normalizeRoom(value) {
  return String(value || 'geral')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48) || 'geral';
}

function normalizeName(value) {
  return String(value || 'Visitante').trim().replace(/\s+/g, ' ').slice(0, 32) || 'Visitante';
}

function getIceServers() {
  if (process.env.ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (error) {
      console.error('ICE_SERVERS_JSON inválido:', error.message);
    }
  }

  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];
}

function publicUser(user) {
  return {
    peerId: user.peerId,
    name: user.name,
    roomId: user.roomId,
    mic: !!user.mic,
    camera: !!user.camera,
    screen: !!user.screen,
    joinedAt: user.joinedAt,
  };
}

function roomMembers(roomId) {
  return [...(rooms.get(roomId)?.values() || [])].map(publicUser);
}

function directorySnapshot() {
  const ids = new Set([...DEFAULT_CHANNELS, ...rooms.keys()]);
  return [...ids].map((roomId) => ({
    roomId,
    members: roomMembers(roomId),
  }));
}

function emitDirectory() {
  io.emit('directory', directorySnapshot());
}

function systemMessage(roomId, text) {
  const message = {
    id: `system-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'system',
    name: APP_NAME,
    text,
    at: Date.now(),
  };
  const list = history.get(roomId) || [];
  list.push(message);
  history.set(roomId, list.slice(-80));
  io.to(roomId).emit('chat-message', message);
}

function leaveRoom(socket, announce = true) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  const previous = room?.get(socket.id);

  room?.delete(socket.id);
  if (room && room.size === 0) rooms.delete(roomId);

  socket.leave(roomId);
  socket.data.roomId = null;

  if (announce && previous) {
    socket.to(roomId).emit('peer-left', { peerId: socket.id, name: previous.name });
    systemMessage(roomId, `${previous.name} saiu do canal de voz.`);
  }

  io.to(roomId).emit('room-users', roomMembers(roomId));
  emitDirectory();
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  next();
});
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m', etag: true }));

app.get('/api/config', (_req, res) => {
  const iceServers = getIceServers();
  res.json({
    appName: APP_NAME,
    iceServers,
    hasTurn: iceServers.some((item) => {
      const urls = Array.isArray(item.urls) ? item.urls : [item.urls];
      return urls.some((url) => String(url).startsWith('turn:') || String(url).startsWith('turns:'));
    }),
    channels: DEFAULT_CHANNELS,
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), rooms: rooms.size, users: io.engine.clientsCount });
});

io.on('connection', (socket) => {
  socket.emit('directory', directorySnapshot());

  socket.on('join-room', ({ roomId, name }, reply = () => {}) => {
    const nextRoom = normalizeRoom(roomId);
    const nextName = normalizeName(name);

    leaveRoom(socket, false);

    const existing = roomMembers(nextRoom);
    socket.join(nextRoom);

    const user = {
      peerId: socket.id,
      name: nextName,
      roomId: nextRoom,
      mic: false,
      camera: false,
      screen: false,
      joinedAt: Date.now(),
    };

    if (!rooms.has(nextRoom)) rooms.set(nextRoom, new Map());
    rooms.get(nextRoom).set(socket.id, user);

    socket.data.roomId = nextRoom;
    socket.data.name = nextName;

    reply({
      ok: true,
      selfId: socket.id,
      roomId: nextRoom,
      members: existing,
      history: history.get(nextRoom) || [],
      directory: directorySnapshot(),
    });

    socket.to(nextRoom).emit('peer-joined', publicUser(user));
    io.to(nextRoom).emit('room-users', roomMembers(nextRoom));
    systemMessage(nextRoom, `${nextName} entrou no canal de voz.`);
    emitDirectory();
  });

  socket.on('signal', ({ to, data }) => {
    if (!to || !data) return;
    const target = io.sockets.sockets.get(to);
    if (!target || !socket.data.roomId || target.data.roomId !== socket.data.roomId) return;
    io.to(to).emit('signal', {
      from: socket.id,
      name: socket.data.name || 'Visitante',
      data,
    });
  });

  socket.on('presence-update', ({ mic, camera, screen }) => {
    const roomId = socket.data.roomId;
    const user = rooms.get(roomId)?.get(socket.id);
    if (!roomId || !user) return;

    user.mic = !!mic;
    user.camera = !!camera;
    user.screen = !!screen;

    io.to(roomId).emit('presence-update', publicUser(user));
    emitDirectory();
  });

  socket.on('chat-message', ({ text }, reply = () => {}) => {
    const roomId = socket.data.roomId;
    const clean = String(text || '').trim().slice(0, 2000);
    if (!roomId || !clean) return reply({ ok: false });

    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: 'user',
      from: socket.id,
      name: socket.data.name || 'Visitante',
      text: clean,
      at: Date.now(),
    };

    const list = history.get(roomId) || [];
    list.push(message);
    history.set(roomId, list.slice(-80));
    io.to(roomId).emit('chat-message', message);
    reply({ ok: true });
  });

  socket.on('leave-room', () => leaveRoom(socket, true));
  socket.on('disconnect', () => leaveRoom(socket, true));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`${APP_NAME} rodando na porta ${PORT}`);
});
