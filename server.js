require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const https = require('https');
const { createServer } = require('http');
const { Server } = require('socket.io');

const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');
const Message = require('./models/Message');
const User = require('./models/User');

const app = express();
const httpServer = createServer(app);

// ─── STORAGE ─────────────────────────────────────────

// online users
const onlineUsers = {};

// call rooms
// { roomId: [{ uid, socketId }] }
const callRooms = {};

// export for chatRoutes
module.exports.isUserOnline = (uid) => !!onlineUsers[uid];

// ─── SOCKET SETUP ────────────────────────────────────

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ─── EXPRESS ─────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);

// ─── KEEP SERVER ALIVE ───────────────────────────────

setInterval(() => {
  if (process.env.RENDER_URL) {
    https.get(process.env.RENDER_URL).on('error', () => {});
  }
}, 9 * 60 * 1000);

// ────────────────────────────────────────────────────
// 🔥 SOCKET LOGIC
// ────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('✅ Connected:', socket.id);

  // ─── USER ONLINE ────────────────────────────────
  socket.on('user_online', (uid) => {
    onlineUsers[uid] = socket.id;
    socket.uid = uid;

    io.emit('user_status', { uid, status: 'online' });
    console.log('👤 Online:', uid);
  });

  // ─── JOIN ROOM ────────────────────────────────
  socket.on('join_call_room', ({ roomId, uid }) => {
    if (!callRooms[roomId]) callRooms[roomId] = [];

    // remove duplicate
    callRooms[roomId] = callRooms[roomId].filter(u => u.uid !== uid);

    callRooms[roomId].push({ uid, socketId: socket.id });

    socket.join(roomId);

    // send existing users
    const existingUsers = callRooms[roomId]
      .filter(u => u.uid !== uid)
      .map(u => u.uid);

    socket.emit('all_users', existingUsers);

    socket.to(roomId).emit('user_joined', uid);

    console.log(`👥 ${uid} joined ${roomId}`);
  });

  // ─── ADD USER TO CALL ───────────────────────────
  socket.on('add_user_to_call', ({ roomId, newUserUid, callType, callerName }) => {
    const target = onlineUsers[newUserUid];

    if (!target) return;

    io.to(target).emit('incoming_call', {
      callerUid: roomId,
      callType,
      callerName: callerName || 'Group Call',
      isGroupCall: true,
    });
  });

  // ─── LEAVE CALL (IMPORTANT FIX) ─────────────────
  socket.on('call_ended', ({ roomId, uid }) => {
    console.log(`📴 ${uid} left room ${roomId}`);

    if (!callRooms[roomId]) return;

    // remove user
    callRooms[roomId] = callRooms[roomId].filter(u => u.uid !== uid);

    socket.leave(roomId);

    // notify others
    socket.to(roomId).emit('user_left', uid);

    // if only 1 or 0 left → end room
    if (callRooms[roomId].length <= 1) {
      const remaining = callRooms[roomId];

      delete callRooms[roomId];

      remaining?.forEach(u => {
        io.to(u.socketId).emit('call_ended');
      });

      console.log(`🗑️ Room ${roomId} deleted`);
    }
  });

  // ─── WEBRTC SIGNALING ───────────────────────────
  socket.on('webrtc_offer', ({ to, offer }) => {
    const sid = onlineUsers[to];
    if (sid) io.to(sid).emit('webrtc_offer', { from: socket.uid, offer });
  });

  socket.on('webrtc_answer', ({ to, answer }) => {
    const sid = onlineUsers[to];
    if (sid) io.to(sid).emit('webrtc_answer', { from: socket.uid, answer });
  });

  socket.on('webrtc_ice_candidate', ({ to, candidate }) => {
    const sid = onlineUsers[to];
    if (sid) io.to(sid).emit('webrtc_ice_candidate', { from: socket.uid, candidate });
  });

  // ─── CHAT ──────────────────────────────────────
  socket.on('send_message', async (data) => {
    const { chatId, senderUid, receiverUid, text } = data;

    const saved = await Message.create({
      chatId,
      senderUid,
      receiverUid,
      text,
    });

    const receiverSid = onlineUsers[receiverUid];

    if (receiverSid) {
      io.to(receiverSid).emit('receive_message', saved);
    }

    socket.emit('message_sent', saved);
  });

  // ─── DISCONNECT (IMPORTANT FIX) ─────────────────
  socket.on('disconnect', () => {
    const uid = socket.uid;

    if (!uid) return;

    delete onlineUsers[uid];
    io.emit('user_status', { uid, status: 'offline' });

    // remove from room
    for (const [roomId, members] of Object.entries(callRooms)) {
      const exists = members.find(u => u.uid === uid);

      if (exists) {
        callRooms[roomId] = members.filter(u => u.uid !== uid);

        socket.to(roomId).emit('user_left', uid);

        if (callRooms[roomId].length <= 1) {
          const remaining = callRooms[roomId];

          delete callRooms[roomId];

          remaining?.forEach(u => {
            io.to(u.socketId).emit('call_ended');
          });
        }

        break;
      }
    }

    console.log('❌ Disconnected:', uid);
  });
});

// ─── DB + SERVER START ───────────────────────────────

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB connected');
    httpServer.listen(process.env.PORT || 5000, () =>
      console.log(`🚀 Server running on ${process.env.PORT || 5000}`)
    );
  })
  .catch(err => {
    console.error('DB error:', err);
    process.exit(1);
  });