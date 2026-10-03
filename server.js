const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "camera=(self), microphone=(self), display-capture=(self)"
  );
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

function getIceServers() {
  if (process.env.ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (err) {
      console.error("ICE_SERVERS_JSON inválido:", err.message);
    }
  }

  return [{ urls: "stun:stun.l.google.com:19302" }];
}

app.get("/api/config", (req, res) => {
  res.json({
    appName: process.env.APP_NAME || "RaiCord",
    iceServers: getIceServers()
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  socket.to(roomId).emit("peer-left", {
    peerId: socket.id,
    name: socket.data.name || "Usuário"
  });

  socket.leave(roomId);
  socket.data.roomId = null;
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, name }, reply = () => {}) => {
    roomId = String(roomId || "").trim().slice(0, 64);
    name = String(name || "Usuário").trim().slice(0, 32) || "Usuário";

    if (!roomId) {
      reply({ ok: false, error: "Sala inválida." });
      return;
    }

    leaveCurrentRoom(socket);

    const room = io.sockets.adapter.rooms.get(roomId);
    const members = room
      ? [...room]
          .filter((id) => id !== socket.id)
          .map((id) => {
            const member = io.sockets.sockets.get(id);
            return {
              peerId: id,
              name: member?.data?.name || "Usuário"
            };
          })
      : [];

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;

    socket.to(roomId).emit("peer-joined", {
      peerId: socket.id,
      name
    });

    reply({
      ok: true,
      selfId: socket.id,
      members,
      roomId
    });
  });

  socket.on("signal", ({ to, data }) => {
    if (!to || !data) return;

    const target = io.sockets.sockets.get(to);
    if (!target) return;

    if (
      socket.data.roomId &&
      target.data.roomId &&
      socket.data.roomId === target.data.roomId
    ) {
      io.to(to).emit("signal", {
        from: socket.id,
        name: socket.data.name || "Usuário",
        data
      });
    }
  });

  socket.on("chat-message", ({ text }, reply = () => {}) => {
    const roomId = socket.data.roomId;
    const clean = String(text || "").trim().slice(0, 2000);

    if (!roomId || !clean) {
      reply({ ok: false });
      return;
    }

    io.to(roomId).emit("chat-message", {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      from: socket.id,
      name: socket.data.name || "Usuário",
      text: clean,
      at: Date.now()
    });

    reply({ ok: true });
  });

  socket.on("room-state", ({ state }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !state) return;

    socket.to(roomId).emit("room-state", {
      peerId: socket.id,
      state: {
        mic: Boolean(state.mic),
        camera: Boolean(state.camera),
        screen: Boolean(state.screen)
      }
    });
  });

  socket.on("leave-room", () => {
    leaveCurrentRoom(socket);
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`RaiCord rodando em http://localhost:${PORT}`);
});
