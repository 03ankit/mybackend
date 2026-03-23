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
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.get('/', (req, res) => res.json({ message: 'Chat App Backend Running ✅' }));

// ─── Online Users ─────────────────────────────────────
const onlineUsers = {}; // { uid: socketId }

io.on('connection', (socket) => {
  console.log('✅ Socket connected:', socket.id);

  // ─── User online ───────────────────────────────────
  socket.on('user_online', (uid) => {
    onlineUsers[uid] = socket.id;
    console.log('👤 Online:', uid);
    io.emit('user_status', { uid, status: 'online' });
  });

  // ─── Send message ──────────────────────────────────
  socket.on('send_message', async (data) => {
    try {
      const { chatId, senderUid, receiverUid, text } = data;
      console.log('💬 Message:', senderUid, '→', receiverUid);

      // save to MongoDB
      const saved = await Message.create({
        chatId, senderUid, receiverUid,
        text, type: 'text',
      });

      const msgData = {
        _id:         saved._id,
        chatId,      senderUid,
        receiverUid, text,
        type:        'text',
        createdAt:   saved.createdAt,
        read:        false,
      };

      // send to receiver if online
      const receiverSocket = onlineUsers[receiverUid];
      if (receiverSocket) {
        io.to(receiverSocket).emit('receive_message', msgData);
        console.log('✅ Delivered to:', receiverUid);
      } else {
        // offline — send FCM
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

      // confirm to sender
      socket.emit('message_sent', msgData);

    } catch (err) {
      console.error('Message error:', err);
      socket.emit('message_error', { error: 'Failed to send' });
    }
  });

  // ─── Load history ──────────────────────────────────
  socket.on('load_history', async ({ chatId, page = 1 }) => {
    try {
      const limit    = 30;
      const messages = await Message.find({ chatId })
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit);

      socket.emit('chat_history', { chatId, messages, page });
      console.log('✅ History sent:', messages.length, 'msgs');
    } catch (err) {
      console.error('History error:', err);
    }
  });

  // ─── Typing ────────────────────────────────────────
  socket.on('typing', ({ senderUid, receiverUid, isTyping }) => {
    const receiverSocket = onlineUsers[receiverUid];
    if (receiverSocket) {
      io.to(receiverSocket).emit('user_typing', { senderUid, isTyping });
    }
  });

  // ─── Mark read ─────────────────────────────────────
  socket.on('mark_read', async ({ chatId, readerUid }) => {
    try {
      await Message.updateMany(
        { chatId, receiverUid: readerUid, read: false },
        { $set: { read: true } }
      );
      socket.broadcast.emit('messages_read', { chatId, readerUid });
      console.log('✅ Messages read in:', chatId);
    } catch (err) {
      console.error('Mark read error:', err);
    }
  });

  // ─── Call signaling ────────────────────────────────
  socket.on('call_user', (data) => {
    const { receiverUid, channelName, callType, callerName, callerUid } = data;
    const receiverSocket = onlineUsers[receiverUid];
    if (receiverSocket) {
      io.to(receiverSocket).emit('incoming_call', {
        channelName, callType, callerName, callerUid,
      });
      console.log('✅ Call signal sent to:', receiverUid);
    } else {
      console.log('⚠️ Receiver offline for call');
    }
  });

  socket.on('call_accepted', ({ callerUid, channelName }) => {
    const callerSocket = onlineUsers[callerUid];
    if (callerSocket) {
      io.to(callerSocket).emit('call_accepted', { channelName });
    }
  });

  socket.on('call_declined', ({ callerUid }) => {
    const callerSocket = onlineUsers[callerUid];
    if (callerSocket) {
      io.to(callerSocket).emit('call_declined');
    }
  });

  socket.on('call_ended', ({ receiverUid }) => {
    const receiverSocket = onlineUsers[receiverUid];
    if (receiverSocket) {
      io.to(receiverSocket).emit('call_ended');
    }
  });

  // ─── Disconnect ────────────────────────────────────
  socket.on('disconnect', () => {
    const uid = Object.keys(onlineUsers)
      .find(key => onlineUsers[key] === socket.id);
    if (uid) {
      delete onlineUsers[uid];
      io.emit('user_status', { uid, status: 'offline' });
      console.log('❌ Offline:', uid);
    }
  });
});

// ─── MongoDB ──────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB Connected');
    httpServer.listen(process.env.PORT || 5000, () => {
      console.log(`✅ Server running on port ${process.env.PORT || 5000}`);
    });
  })
  .catch(err => console.error('❌ MongoDB error:', err));