require('dotenv').config();

const express          = require('express');
const mongoose         = require('mongoose');
const cors             = require('cors');
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
    origin:  '*',
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

// ✅ Export helper so chatRoutes can check if a user is online before sending FCM
module.exports.isUserOnline = (uid) => !!onlineUsers[uid];

// ─── Health / debug endpoints ─────────────────────────────────────────────────
app.get('/socket-test', (req, res) => {
  res.json({
    message:     'Socket.IO ready ✅',
    connected:   Object.keys(onlineUsers).length,
    onlineUsers: Object.keys(onlineUsers),
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
}, 14 * 60 * 1000);

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('✅ Socket connected:', socket.id);

  // ─── User online ────────────────────────────────────────────────────────────
  // Accepts both   socket.emit('user_online', uid)
  // and            socket.emit('user_online', { uid })
  socket.on('user_online', (payload) => {
    const uid = typeof payload === 'string' ? payload : payload?.uid;
    if (!uid) return;
    onlineUsers[uid] = socket.id;
    console.log('👤 Online:', uid);
    io.emit('user_status', { uid, status: 'online' });
  });

  // ─── ✅ FIX — user_offline handler was missing ────────────────────────────
  socket.on('user_offline', (payload) => {
    const uid = typeof payload === 'string' ? payload : payload?.uid;
    if (!uid) return;
    // Only delete if THIS socket owns that uid (prevent another tab evicting us)
    if (onlineUsers[uid] === socket.id) {
      delete onlineUsers[uid];
      io.emit('user_status', { uid, status: 'offline' });
      console.log('👤 Offline (manual):', uid);
    }
  });

  // ─── Send message ────────────────────────────────────────────────────────────
  socket.on('send_message', async (data) => {
    try {
      const { chatId, senderUid, receiverUid, text } = data;
      console.log('💬 Message:', senderUid, '→', receiverUid);

      const saved = await Message.create({
        chatId, senderUid, receiverUid, text, type: 'text',
      });

      const msgData = {
        _id: saved._id, chatId, senderUid, receiverUid,
        text, type: 'text', createdAt: saved.createdAt, read: false,
      };

      const receiverSocket = onlineUsers[receiverUid];
      if (receiverSocket) {
        io.to(receiverSocket).emit('receive_message', msgData);
        console.log('✅ Delivered to:', receiverUid);
      } else {
        // ✅ Only send FCM when receiver is actually offline
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

  // ─── Load history ────────────────────────────────────────────────────────────
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

  // ─── Typing ──────────────────────────────────────────────────────────────────
  socket.on('typing', ({ senderUid, receiverUid, isTyping }) => {
    const receiverSocket = onlineUsers[receiverUid];
    if (receiverSocket) {
      io.to(receiverSocket).emit('user_typing', { senderUid, isTyping });
    }
  });

  // ─── Mark read ───────────────────────────────────────────────────────────────
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

  // ─── Call signaling ───────────────────────────────────────────────────────────

  // Caller → receiver: incoming call
  socket.on('call_user', (data) => {
    const { receiverUid, channelName, callType, callerName, callerUid } = data;
    const receiverSocket = onlineUsers[receiverUid];
    if (receiverSocket) {
      io.to(receiverSocket).emit('incoming_call', {
        channelName, callType, callerName, callerUid,
      });
      console.log('✅ Call signal sent to:', receiverUid);
    } else {
      console.log('⚠️ Receiver offline — FCM sent via REST /start-call');
    }
  });

  // Receiver → caller: call accepted
  // ✅ This is the key relay — the caller's VideoCall screen listens for this
  //    and only then joins the Agora channel.
  socket.on('call_accepted', ({ callerUid, channelName }) => {
    const callerSocket = onlineUsers[callerUid];
    console.log('📞 call_accepted: relaying to caller', callerUid, '| socket:', callerSocket);
    if (callerSocket) {
      io.to(callerSocket).emit('call_accepted', { channelName });
    }
  });

  // Receiver → caller: call declined
  socket.on('call_declined', ({ callerUid }) => {
    const callerSocket = onlineUsers[callerUid];
    if (callerSocket) {
      io.to(callerSocket).emit('call_declined');
    }
  });

  // ✅ FIX — call_ended now uses targetUid so BOTH caller and receiver can end
  // Old:  socket.on('call_ended', ({ receiverUid }) — only caller could end
  // New:  socket.on('call_ended', ({ targetUid })   — either side can end
  socket.on('call_ended', ({ targetUid }) => {
    const targetSocket = onlineUsers[targetUid];
    if (targetSocket) {
      io.to(targetSocket).emit('call_ended');
      console.log('📵 call_ended sent to:', targetUid);
    }
  });

  // ─── Disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const uid = Object.keys(onlineUsers).find(key => onlineUsers[key] === socket.id);
    if (uid) {
      delete onlineUsers[uid];
      io.emit('user_status', { uid, status: 'offline' });
      console.log('❌ Disconnected / offline:', uid);
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