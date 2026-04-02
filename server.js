require('dotenv').config();

const express        = require('express');
const mongoose       = require('mongoose');
const cors           = require('cors');
const https          = require('https');
const { createServer } = require('http');
const { Server }       = require('socket.io');

const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');
const Message    = require('./models/Message');
const User       = require('./models/User');

const app        = express();
const httpServer = createServer(app);

// ─── Active call registry ─────────────────────────────────────────────────────
//
//  Key   : callerUid  (stable — doesn't change on reconnect)
//  Value : {
//    callerUid, receiverUid,
//    callerSid, receiverSid,
//    status: 'pending' | 'active' | 'ended'
//  }
//
const activeCalls = new Map();

// ─── Online users  { uid → socketId } ────────────────────────────────────────
const onlineUsers = {};

// ─── Call rooms  { roomId → [{ uid, socketId }] } ────────────────────────────
//
//  roomId is always the original callerUid.
//  Populated on 'join_call_room'; cleaned up when the call ends or the
//  last participant leaves.
//
const callRooms = {};

// ✅ Export so chatRoutes can gate FCM behind "is user online?"
module.exports.isUserOnline = (uid) => !!onlineUsers[uid];

// ─── Express setup ────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin:      '*',
    methods:     ['GET', 'POST'],
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

// ─── Debug endpoint ───────────────────────────────────────────────────────────
app.get('/socket-test', (_req, res) => {
  res.json({
    message:      'Socket.IO ready ✅',
    onlineCount:  Object.keys(onlineUsers).length,
    onlineUsers:  Object.keys(onlineUsers),
    activeCalls:  [...activeCalls.values()],
    callRooms:    Object.fromEntries(
      Object.entries(callRooms).map(([k, v]) => [k, v.map(u => u.uid)])
    ),
  });
});

// ─── Keep Render free tier alive ─────────────────────────────────────────────
setInterval(() => {
  const url = process.env.RENDER_URL;
  if (!url) return;
  https.get(url, (r) => console.log('🏓 Keep-alive:', r.statusCode))
       .on('error', () => {});
}, 9 * 60 * 1000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Emit `call_ended` to BOTH participants and remove from registry.
 * Also tears down the callRoom for this callerUid.
 * Idempotent — safe to call multiple times.
 */
function terminateCall(callerUid, endedBy) {
  const call = activeCalls.get(callerUid);
  if (!call || call.status === 'ended') return;

  call.status = 'ended';
  activeCalls.delete(callerUid);

  // ── Clean up the call room ──────────────────────────────────────────────
  delete callRooms[callerUid];

  console.log(`📴 terminateCall | callerUid=${callerUid} | endedBy=${endedBy}`);

  // Notify caller
  const callerSid = onlineUsers[call.callerUid];
  if (callerSid) io.to(callerSid).emit('call_ended', { endedBy });

  // Notify receiver
  const receiverSid = onlineUsers[call.receiverUid];
  if (receiverSid) io.to(receiverSid).emit('call_ended', { endedBy });
}

/**
 * Find the active call that a given uid is participating in (either side).
 */
function findCallByUid(uid) {
  for (const call of activeCalls.values()) {
    if (call.callerUid === uid || call.receiverUid === uid) return call;
  }
  return undefined;
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('✅ Socket connected:', socket.id);

  // ── Keep-alive ping ────────────────────────────────────────────────────────
  socket.on('ping', () => socket.emit('pong'));

  // ── User online ────────────────────────────────────────────────────────────
  socket.on('user_online', (payload) => {
    const uid = typeof payload === 'string' ? payload : payload?.uid;
    if (!uid) return;

    onlineUsers[uid] = socket.id;
    socket.uid = uid;

    console.log('👤 Online:', uid, '| socket:', socket.id);
    io.emit('user_status', { uid, status: 'online' });
  });

  // ── User offline (manual) ─────────────────────────────────────────────────
  socket.on('user_offline', (payload) => {
    const uid = typeof payload === 'string' ? payload : payload?.uid;
    if (!uid) return;
    if (onlineUsers[uid] === socket.id) {
      delete onlineUsers[uid];
      io.emit('user_status', { uid, status: 'offline' });
      console.log('👤 Offline (manual):', uid);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  CALL SIGNALING
  // ══════════════════════════════════════════════════════════════════════════

  // ── 1. Caller initiates a 1-to-1 call ────────────────────────────────────
  socket.on('call_user', ({ callerUid, receiverUid, callType, callerName, callerImage }) => {
    console.log(`📞 call_user | ${callerUid} → ${receiverUid}`);

    activeCalls.set(callerUid, {
      callerUid,
      receiverUid,
      callerSid:   socket.id,
      receiverSid: null,
      status:      'pending',
    });

    const receiverSid = onlineUsers[receiverUid];
    if (receiverSid) {
      io.to(receiverSid).emit('incoming_call', {
        callType, callerName, callerImage, callerUid,
      });
    } else {
      console.log('⚠️  Receiver offline — push via FCM');
    }
  });

  // ── 2. Receiver: race-condition guard ─────────────────────────────────────
  socket.on('check_call_status', ({ callerUid }) => {
    const call = activeCalls.get(callerUid);
    if (!call || call.status === 'ended') {
      socket.emit('call_already_ended');
      console.log(`⚠️  check_call_status — call gone | callerUid=${callerUid}`);
    }
  });

  // ── 3. Receiver accepts ────────────────────────────────────────────────────
  socket.on('call_accepted', ({ callerUid }) => {
    const call = activeCalls.get(callerUid);

    if (!call || call.status === 'ended') {
      socket.emit('call_already_ended');
      return;
    }

    call.status      = 'active';
    call.receiverSid = socket.id;
    activeCalls.set(callerUid, call);

    const callerSid = onlineUsers[callerUid];
    if (callerSid) {
      io.to(callerSid).emit('call_accepted', { from: socket.uid });
      console.log(`✅ call_accepted | notified caller ${callerUid}`);
    }
  });

  // ── 4. Receiver declines ──────────────────────────────────────────────────
  socket.on('call_declined', ({ callerUid }) => {
    activeCalls.delete(callerUid);
    delete callRooms[callerUid]; // clean room if it was pre-created

    const callerSid = onlineUsers[callerUid];
    if (callerSid) io.to(callerSid).emit('call_declined');

    console.log(`🚫 call_declined | callerUid=${callerUid}`);
  });

  // ── 5. Either side ends the call ─────────────────────────────────────────
  socket.on('call_ended', ({ callerUid }) => {
    const call = activeCalls.get(callerUid);

    if (!call || call.status === 'ended') {
      console.log('⚠️  Ignored duplicate call_ended:', callerUid);
      return;
    }

    console.log(`📴 call_ended | callerUid=${callerUid} | from=${socket.uid}`);
    terminateCall(callerUid, socket.uid);
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  CALL ROOMS  (multi-party WebRTC mesh)
  // ══════════════════════════════════════════════════════════════════════════

  // ── Join room ─────────────────────────────────────────────────────────────
  //
  //  Both the original caller and every added participant emit this.
  //  roomId = callerUid (stable identifier for this call session).
  //
  socket.on('join_call_room', ({ roomId, uid }) => {
    if (!callRooms[roomId]) callRooms[roomId] = [];

    // Avoid duplicate entries on re-join
    callRooms[roomId] = callRooms[roomId].filter(u => u.uid !== uid);
    callRooms[roomId].push({ uid, socketId: socket.id });

    // Tell the newcomer who is already in the room (so they can create offers)
    const existingUids = callRooms[roomId]
      .filter(u => u.uid !== uid)
      .map(u => u.uid);

    socket.emit('all_users', existingUids);

    // Tell everyone else a new participant joined
    socket.to(roomId).emit('user_joined', uid);

    socket.join(roomId);

    console.log(`👥 ${uid} joined room ${roomId} | members: ${callRooms[roomId].map(u => u.uid)}`);
  });

  // ── Add a NEW user to an existing call ───────────────────────────────────
  //
  //  Emitted by VideoCall when the in-call "+" button is used.
  //  The server looks up the target's socket and sends them an incoming_call
  //  event shaped exactly like a normal call so the same ring screen is shown.
  //
  //  The client then navigates to VideoCall with type='incoming', and joins
  //  the room via join_call_room as normal.
  //
  socket.on('add_user_to_call', ({ roomId, newUserUid, callType, callerName, callerImage }) => {
    const targetSid = onlineUsers[newUserUid];

    if (!targetSid) {
      console.log(`⚠️  add_user_to_call — ${newUserUid} is offline`);
      // Optionally: emit back to caller that the user is offline
      socket.emit('add_user_failed', { uid: newUserUid, reason: 'offline' });
      return;
    }

    // Reuse the same incoming_call event — client handling is identical
    io.to(targetSid).emit('incoming_call', {
      callerUid:   roomId,       // roomId IS the callerUid — used to join room
      callType:    callType  || 'video',
      callerName:  callerName  || 'Group Call',
      callerImage: callerImage || null,
      isGroupCall: true,         // optional flag so UI can say "Group Call"
    });

    console.log(`➕ Invited ${newUserUid} to room ${roomId}`);
  });

  // ── Leave room (explicit) ─────────────────────────────────────────────────
  socket.on('leave_call_room', ({ roomId, uid }) => {
    if (!callRooms[roomId]) return;

    callRooms[roomId] = callRooms[roomId].filter(u => u.uid !== uid);
    socket.leave(roomId);
    socket.to(roomId).emit('user_left', uid);

    console.log(`🚪 ${uid} left room ${roomId} | remaining: ${callRooms[roomId].map(u => u.uid)}`);

    // If room is now empty, delete it
    if (callRooms[roomId].length === 0) {
      delete callRooms[roomId];
      console.log(`🗑️  Room ${roomId} deleted (empty)`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  WebRTC SIGNALING  (pure relay — no call-state logic)
  // ══════════════════════════════════════════════════════════════════════════

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

  // ══════════════════════════════════════════════════════════════════════════
  //  CHAT
  // ══════════════════════════════════════════════════════════════════════════

  socket.on('send_message', async (data) => {
    try {
      const { chatId, senderUid, receiverUid, text } = data;

      const saved = await Message.create({
        chatId, senderUid, receiverUid, text, type: 'text',
      });

      const msgData = {
        _id: saved._id, chatId, senderUid, receiverUid,
        text, type: 'text', createdAt: saved.createdAt, read: false,
      };

      const receiverSid = onlineUsers[receiverUid];
      if (receiverSid) {
        io.to(receiverSid).emit('receive_message', msgData);
      } else {
        const [receiver, sender] = await Promise.all([
          User.findOne({ uid: receiverUid }),
          User.findOne({ uid: senderUid }),
        ]);
        if (receiver?.fcmToken) {
          const { sendNotification } = require('./services/notificationService');
          await sendNotification({
            fcmToken: receiver.fcmToken,
            title:    sender?.name || sender?.phone || 'New Message',
            body:     text,
            data:     {
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

  socket.on('typing', ({ senderUid, receiverUid, isTyping }) => {
    const sid = onlineUsers[receiverUid];
    if (sid) io.to(sid).emit('user_typing', { senderUid, isTyping });
  });

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

  // ══════════════════════════════════════════════════════════════════════════
  //  DISCONNECT
  // ══════════════════════════════════════════════════════════════════════════
  socket.on('disconnect', (reason) => {
    const uid = socket.uid;
    console.log(`🔴 Disconnect | uid=${uid ?? 'unknown'} | reason=${reason}`);

    if (uid) {
      if (onlineUsers[uid] === socket.id) {
        delete onlineUsers[uid];
        io.emit('user_status', { uid, status: 'offline' });
      }

      // ── Remove from any call room they were in ──────────────────────────
      for (const [roomId, members] of Object.entries(callRooms)) {
        const was = members.find(u => u.uid === uid);
        if (was) {
          callRooms[roomId] = members.filter(u => u.uid !== uid);
          io.to(roomId).emit('user_left', uid);
          if (callRooms[roomId].length === 0) {
            delete callRooms[roomId];
          }
          break;
        }
      }

      // ── Auto-end 1-to-1 call with grace period ──────────────────────────
      const call = findCallByUid(uid);
      if (call) {
        console.log(`⏳ Grace period for uid=${uid} | callerUid=${call.callerUid}`);
        setTimeout(() => {
          const still = activeCalls.get(call.callerUid);
          if (still && still.status !== 'ended') {
            console.log(`📴 Grace expired — terminating | uid=${uid}`);
            terminateCall(call.callerUid, uid);
          }
        }, 4000);
      }
    }
  });
});

// ─── MongoDB + start ──────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB Connected');
    httpServer.listen(process.env.PORT || 5000, () =>
      console.log(`✅ Server on port ${process.env.PORT || 5000}`)
    );
  })
  .catch((err) => console.error('❌ MongoDB error:', err));