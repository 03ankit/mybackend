require('dotenv').config();

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const { createServer } = require('http');
const { Server }       = require('socket.io');

const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');
const Message    = require('./models/Message');
const User       = require('./models/User');

const app        = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false,
  },
  transports:     ['polling', 'websocket'],
  allowEIO3:      true,
  pingTimeout:    60000,
  pingInterval:   25000,
  upgradeTimeout: 30000,
  allowUpgrades:  true,
  cookie:         false,
});

app.use(cors());
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);

// ─── Online users map ─────────────────────────────────────────────────────────
// { uid: socketId }
const onlineUsers = {};

// ─── ✅ Pending calls store ───────────────────────────────────────────────────
// Tracks calls that are ringing but not yet accepted
// { callerUid: { receiverUid, timestamp } }
const pendingCalls = new Map();

// ✅ Stale call cleanup — removes calls older than 60s (missed/no-answer)
setInterval(() => {
  const now = Date.now();
  for (const [callerUid, data] of pendingCalls.entries()) {
    if (now - data.timestamp > 60_000) {
      console.log(`🧹 Stale call cleaned: ${callerUid}`);

      // Notify receiver if still online
      const receiverSocketId = onlineUsers[data.receiverUid];
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('call_ended');
      }

      pendingCalls.delete(callerUid);
    }
  }
}, 30_000);

// ✅ Export so chatRoutes can check online status
module.exports.isUserOnline = (uid) => !!onlineUsers[uid];

// ─── Health / debug endpoints ─────────────────────────────────────────────────
app.get('/socket-test', (req, res) => {
  res.json({
    message:      'Socket.IO ready ✅',
    connected:    Object.keys(onlineUsers).length,
    onlineUsers:  Object.keys(onlineUsers),
    pendingCalls: [...pendingCalls.keys()],    // ✅ useful for debugging
  });
});

// ─── Keep alive ping (Render free tier) ──────────────────────────────────────
const https = require('https');
setInterval(() => {
  const url = process.env.RENDER_URL;
  if (!url) return;
  https.get(url, (res) => {
    console.log('🏓 Keep-alive ping:', res.statusCode);
  }).on('error', () => {});
}, 9 * 60 * 1000);

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('✅ Socket connected:', socket.id);

  // ── Keepalive ping ──────────────────────────────────────────────────────────
  socket.on('ping', () => socket.emit('pong'));

  // ── User online ─────────────────────────────────────────────────────────────
  socket.on('user_online', (payload) => {
    const uid = typeof payload === 'string' ? payload : payload?.uid;
    if (!uid) return;
    onlineUsers[uid] = socket.id;
    socket.userId = uid;
    console.log('👤 Online:', uid);
    io.emit('user_status', { uid, status: 'online' });
  });

  // ── User offline (manual) ───────────────────────────────────────────────────
  socket.on('user_offline', (payload) => {
    const uid = typeof payload === 'string' ? payload : payload?.uid;
    if (!uid) return;
    if (onlineUsers[uid] === socket.id) {
      delete onlineUsers[uid];
      io.emit('user_status', { uid, status: 'offline' });
      console.log('👤 Offline (manual):', uid);
    }
  });

  // ── Send message ────────────────────────────────────────────────────────────
  socket.on('send_message', async (data) => {
    try {
      const { chatId, senderUid, receiverUid, text } = data;
      console.log('💬 Message:', senderUid, '→', receiverUid);

      const saved = await Message.create({
        chatId, senderUid, receiverUid, text, type: 'text',
      });

      const msgData = {
        _id:       saved._id,
        chatId,    senderUid, receiverUid,
        text,      type: 'text',
        createdAt: saved.createdAt,
        read:      false,
      };

      const receiverSocket = onlineUsers[receiverUid];
      if (receiverSocket) {
        io.to(receiverSocket).emit('receive_message', msgData);
        console.log('✅ Delivered to:', receiverUid);
      } else {
        console.log('⚠️ Receiver offline — sending FCM');
        const receiver = await User.findOne({ uid: receiverUid });
        const sender   = await User.findOne({ uid: senderUid });
        if (receiver?.fcmToken) {
          const { sendNotification } = require('./services/notificationService');
          await sendNotification({
            fcmToken: receiver.fcmToken,
            title:    sender?.name || sender?.phone || 'New Message',
            body:     text,
            data: {
              type:       'chat_message',
              chatId,
              senderUid,
              senderName: sender?.name || sender?.phone || '',
            },
          });
        }
      }

      socket.emit('message_sent', msgData);

    } catch (err) {
      console.error('Message error:', err);
      socket.emit('message_error', { error: 'Failed to send' });
    }
  });

  // ── Load history ────────────────────────────────────────────────────────────
  socket.on('load_history', async ({ chatId, page = 1 }) => {
    try {
      const limit    = 30;
      const messages = await Message.find({ chatId })
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit);
      socket.emit('chat_history', { chatId, messages, page });
    } catch (err) {
      console.error('History error:', err);
    }
  });

  // ── Typing ──────────────────────────────────────────────────────────────────
  socket.on('typing', ({ senderUid, receiverUid, isTyping }) => {
    const receiverSocket = onlineUsers[receiverUid];
    if (receiverSocket) {
      io.to(receiverSocket).emit('user_typing', { senderUid, isTyping });
    }
  });

  // ── Mark read ───────────────────────────────────────────────────────────────
  socket.on('mark_read', async ({ chatId, readerUid }) => {
    try {
      await Message.updateMany(
        { chatId, receiverUid: readerUid, read: false },
        { $set: { read: true } }
      );
      socket.broadcast.emit('messages_read', { chatId, readerUid });
    } catch (err) {
      console.error('Mark read error:', err);
    }
  });

  // ── WebRTC signaling ────────────────────────────────────────────────────────

  socket.on('webrtc_offer', ({ to, offer }) => {
    const targetSocket = onlineUsers[to];
    console.log('📡 OFFER from', socket.userId, '→', to);
    if (targetSocket) {
      io.to(targetSocket).emit('webrtc_offer', { from: socket.userId, offer });
    }
  });

  socket.on('webrtc_answer', ({ to, answer }) => {
    const targetSocket = onlineUsers[to];
    console.log('📡 ANSWER from', socket.userId, '→', to);
    if (targetSocket) {
      io.to(targetSocket).emit('webrtc_answer', { from: socket.userId, answer });
    }
  });

  socket.on('webrtc_ice_candidate', ({ to, candidate }) => {
    const targetSocket = onlineUsers[to];
    if (targetSocket) {
      io.to(targetSocket).emit('webrtc_ice_candidate', {
        from: socket.userId, candidate,
      });
    }
  });

  // ── Call signaling ──────────────────────────────────────────────────────────

  // Caller → receiver: initiate call
  socket.on('call_user', ({ receiverUid, callType, callerName, callerUid, channelName }) => {
    console.log(`📞 call_user: ${callerUid} → ${receiverUid}`);

    // ✅ Store in pendingCalls so we can validate accept later
    pendingCalls.set(callerUid, { receiverUid, timestamp: Date.now() });
    socket.activeCallTarget = receiverUid;

    const receiverSocket = onlineUsers[receiverUid];
    if (receiverSocket) {
      io.to(receiverSocket).emit('incoming_call', {
        callerUid, callerName, callType, channelName,
      });
      console.log('✅ Incoming call signal sent to:', receiverUid);
    } else {
      // Receiver offline → cancel immediately, tell caller
      pendingCalls.delete(callerUid);
      socket.emit('call_no_answer', { receiverUid });
      console.log('⚠️ Receiver offline');
    }
  });

  // ✅ Receiver asks on screen mount: "Is this call still alive?"
  // Fixes the race where caller cancelled BEFORE receiver's screen mounted
  socket.on('check_call_status', ({ callerUid }) => {
    const pending = pendingCalls.get(callerUid);
    const isValid = pending && pending.receiverUid === socket.userId;

    if (isValid) {
      console.log(`✅ check_call_status: call from ${callerUid} is still active`);
      socket.emit('call_still_active', { callerUid });
    } else {
      console.log(`⚠️ check_call_status: call from ${callerUid} already ended`);
      socket.emit('call_already_ended');   // receiver screen closes immediately
    }
  });

  // Receiver accepts — server validates FIRST before forwarding to caller
  socket.on('call_accepted', ({ callerUid, channelName }) => {
    const pending = pendingCalls.get(callerUid);

    // ✅ Validate: is this call still pending?
    if (!pending) {
      console.log(`⚠️ call_accepted rejected — call from ${callerUid} no longer pending`);
      socket.emit('call_already_ended');   // tell receiver to close screen
      return;
    }

    // Call is valid — remove from pending and forward to caller
    pendingCalls.delete(callerUid);
    socket.activeCallTarget = callerUid;

    const callerSocket = onlineUsers[callerUid];
    console.log(`✅ call_accepted: relaying to caller ${callerUid}`);
    if (callerSocket) {
      io.to(callerSocket).emit('call_accepted', {
        receiverUid: socket.userId, channelName,
      });
    }
  });

  // Receiver declines
  socket.on('call_declined', ({ callerUid }) => {
    // ✅ Remove from pending
    pendingCalls.delete(callerUid);
    socket.activeCallTarget = null;

    const callerSocket = onlineUsers[callerUid];
    console.log(`❌ call_declined: notifying caller ${callerUid}`);
    if (callerSocket) {
      io.to(callerSocket).emit('call_declined');
    }
  });

  // Either side ends the call
  socket.on('call_ended', ({ targetUid }) => {
    const callerUid = socket.userId;

    // ✅ Clean up pending call if caller is ending before receiver accepts
    if (pendingCalls.has(callerUid)) {
      console.log(`🗑️ Removing pending call: ${callerUid}`);
      pendingCalls.delete(callerUid);
    }

    socket.activeCallTarget = null;
    console.log('📴 call_ended → notifying:', targetUid);

    const targetSocketId = onlineUsers[targetUid];
    if (targetSocketId) {
     io.to(targetSocketId).emit('call_ended', {
  callerUid: callerUid
});
    }
  });

  // ── Disconnect ──────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const uid = socket.userId;
    if (!uid) return;

    delete onlineUsers[uid];
    console.log('🔴 Disconnected:', uid);
    io.emit('user_status', { uid, status: 'offline' });

    // ✅ If this socket had a pending outgoing call → notify receiver
    if (pendingCalls.has(uid)) {
      const { receiverUid } = pendingCalls.get(uid);
      pendingCalls.delete(uid);

      const receiverSocketId = onlineUsers[receiverUid];
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('call_ended');
        console.log(`📴 Caller ${uid} disconnected — notified receiver ${receiverUid}`);
      }
    }

    // ✅ If this socket was in an active call → notify the other side
    if (socket.activeCallTarget) {
      const targetSocketId = onlineUsers[socket.activeCallTarget];
      if (targetSocketId) {
        io.to(targetSocketId).emit('call_ended');
        console.log(`📴 Notified ${socket.activeCallTarget} — peer disconnected`);
      }
    }
  });
});

// ─── MongoDB + start ──────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB Connected');
    httpServer.listen(process.env.PORT || 5000, () => {
      console.log(`✅ Server running on port ${process.env.PORT || 5000}`);
    });
  })
  .catch(err => console.error('❌ MongoDB error:', err));