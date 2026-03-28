require('dotenv').config();

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const https      = require('https');
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
//    callerUid,   receiverUid,
//    callerSid,   receiverSid,   ← socket.id at the time of the event
//    status: 'pending' | 'active' | 'ended'
//  }
//
//  WHY NOT use socketId as key?
//  Socket IDs change on every reconnect. UIDs are stable, so the registry
//  survives brief network blips on either side.
//
const activeCalls = new Map();

// ─── Online users  { uid → socketId } ────────────────────────────────────────
const onlineUsers = {};

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
 * Emit `call_ended` to BOTH participants of a call and remove it from the registry.
 * Safe to call multiple times — idempotent after the first call.
 *
 * @param {string} callerUid   - the key used in activeCalls
 * @param {string} endedBy     - uid of whichever side triggered the end
 */
function terminateCall(callerUid, endedBy) {
  const call = activeCalls.get(callerUid);
  if (!call || call.status === 'ended') return; // already cleaned up

  call.status = 'ended';
  activeCalls.delete(callerUid);

  console.log(`📴 terminateCall | callerUid=${callerUid} | endedBy=${endedBy}`);

  // ── Notify caller ──
  const callerSid = onlineUsers[call.callerUid];
  if (callerSid) {
    io.to(callerSid).emit('call_ended', { endedBy });
  }

  // ── Notify receiver ──
  const receiverSid = onlineUsers[call.receiverUid];
  if (receiverSid) {
    io.to(receiverSid).emit('call_ended', { endedBy });
  }
}

/**
 * Find the active call that a given uid is participating in (either side).
 * Returns the call object or undefined.
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
    socket.uid = uid; // stash on socket so disconnect handler can find it fast

    console.log('👤 Online:', uid, '| socket:', socket.id);
    io.emit('user_status', { uid, status: 'online' });
  });

  // ── User offline (manual) ─────────────────────────────────────────────────
  socket.on('user_offline', (payload) => {
    const uid = typeof payload === 'string' ? payload : payload?.uid;
    if (!uid) return;
    // Only evict if THIS socket still owns that uid (multi-tab safety)
    if (onlineUsers[uid] === socket.id) {
      delete onlineUsers[uid];
      io.emit('user_status', { uid, status: 'offline' });
      console.log('👤 Offline (manual):', uid);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  CALL SIGNALING
  // ══════════════════════════════════════════════════════════════════════════

  // ── 1. Caller initiates ───────────────────────────────────────────────────
  socket.on('call_user', ({ callerUid, receiverUid, callType, callerName, callerImage }) => {
    console.log(`📞 call_user | ${callerUid} → ${receiverUid}`);

    // Register as PENDING in the active-call registry
    activeCalls.set(callerUid, {
      callerUid,
      receiverUid,
      callerSid:   socket.id,
      receiverSid: null,         // filled when receiver accepts
      status:      'pending',
    });

    const receiverSid = onlineUsers[receiverUid];
    if (receiverSid) {
      io.to(receiverSid).emit('incoming_call', {
        callType, callerName, callerImage, callerUid,
      });
    } else {
      console.log('⚠️  Receiver offline — send FCM via REST /start-call');
    }
  });

  // ── 2. Receiver: check if call is still live (race-condition guard) ────────
  //    Frontend emits this immediately when the ring screen mounts.
  //    If the caller already cancelled, we reply with call_already_ended.
  socket.on('check_call_status', ({ callerUid }) => {
    const call = activeCalls.get(callerUid);
    if (!call || call.status === 'ended') {
      socket.emit('call_already_ended');
      console.log(`⚠️  check_call_status — call not found for callerUid=${callerUid}`);
    }
    // else: still alive, no reply needed — ring screen stays open
  });

  // ── 3. Receiver accepts ────────────────────────────────────────────────────
  socket.on('call_accepted', ({ callerUid }) => {
    const call = activeCalls.get(callerUid);

    if (!call || call.status === 'ended') {
      // Caller already cancelled between ring and accept tap
      socket.emit('call_already_ended');
      console.log(`⚠️  call_accepted — call already gone for callerUid=${callerUid}`);
      return;
    }

    // Upgrade to ACTIVE and record receiver's current socket
    call.status      = 'active';
    call.receiverSid = socket.id;
    activeCalls.set(callerUid, call);

    const callerSid = onlineUsers[callerUid];
    if (callerSid) {
      io.to(callerSid).emit('call_accepted', { from: socket.uid });
      console.log(`✅ call_accepted | relayed to caller ${callerUid}`);
    }
  });

  // ── 4. Receiver declines ──────────────────────────────────────────────────
  socket.on('call_declined', ({ callerUid }) => {
    const call = activeCalls.get(callerUid);
    if (call) {
      activeCalls.delete(callerUid);
    }

    const callerSid = onlineUsers[callerUid];
    if (callerSid) {
      io.to(callerSid).emit('call_declined');
    }

    console.log(`🚫 call_declined | callerUid=${callerUid}`);
  });

  // ── 5. Either side ends the call ──────────────────────────────────────────
  //
  //    Frontend sends:  socket.emit('call_ended', { callerUid, targetUid })
  //
  //    callerUid is ALWAYS the original caller's uid — it's the registry key.
  //    We don't need targetUid here at all; terminateCall() looks up both
  //    participants from the registry and notifies them.
  //
  socket.on('call_ended', ({ callerUid }) => {
    console.log(`📴 call_ended received | callerUid=${callerUid} | from socket=${socket.uid}`);
    terminateCall(callerUid, socket.uid);
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  WebRTC SIGNALING  (pure relay — no call-state logic here)
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
            data:     { type: 'chat_message', chatId, senderUid,
                        senderName: sender?.name || sender?.phone || '' },
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
      // Only remove from onlineUsers if this socket is the current one
      // (prevents a stale tab evicting a freshly reconnected session)
      if (onlineUsers[uid] === socket.id) {
        delete onlineUsers[uid];
        io.emit('user_status', { uid, status: 'offline' });
      }

      // ── Auto-end any active call this user was part of ─────────────────
      // We wait 4 seconds before ending, giving the socket a chance to
      // reconnect (mobile apps frequently do a brief disconnect on app-switch).
      // If the user reconnects within 4s and emits user_online again, the
      // activeCalls entry is still present and the call continues normally.
      const call = findCallByUid(uid);
      if (call) {
        console.log(`⏳ Disconnect grace period for uid=${uid} | callerUid=${call.callerUid}`);
        setTimeout(() => {
          // Only fire if the call was NOT already ended and the user did NOT reconnect
          const stillExists = activeCalls.get(call.callerUid);
          if (stillExists && stillExists.status !== 'ended') {
            console.log(`📴 Grace period expired — terminating call for uid=${uid}`);
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