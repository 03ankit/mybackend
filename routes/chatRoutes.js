  const express = require('express');
  const router  = express.Router();
  const verifyFirebaseToken = require('../middleware/firebaseMiddleware');
  const User    = require('../models/User');
  const Message = require('../models/Message');
  const { sendNotification } = require('../services/notificationService');

  // ─── Helper: is this user currently connected via socket? ─────────────────────
  // server.js exports isUserOnline after the socket map is set up.
  // We require lazily to avoid circular-dependency issues at startup.
  const isUserOnline = (uid) => {
    try {
      return require('../server').isUserOnline(uid);
    } catch {
      return false; // safe fallback — send FCM if we can't tell
    }
  };

  // ─── Send message (FCM fallback for offline users) ────────────────────────────
  router.post('/send-message', verifyFirebaseToken, async (req, res) => {
    try {
      const { receiverUid, message } = req.body;
      const { uid, name, phone_number } = req.user;

      const receiver = await User.findOne({ uid: receiverUid });
      if (!receiver) return res.status(404).json({ success: false, error: 'Receiver not found' });

      if (receiver.fcmToken && !isUserOnline(receiverUid)) {
        await sendNotification({
          fcmToken: receiver.fcmToken,
          title:    name || phone_number || 'New Message',
          body:     message,
          data: { type: 'chat_message', senderUid: uid, senderName: name || phone_number || '' },
        });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('Send message error:', err);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  // ─── Get chat history ─────────────────────────────────────────────────────────
  router.get('/history/:chatId', verifyFirebaseToken, async (req, res) => {
    try {
      const { chatId } = req.params;
      const page  = parseInt(req.query.page)  || 1;
      const limit = parseInt(req.query.limit) || 30;

      const messages = await Message.find({ chatId })
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit);

      const total = await Message.countDocuments({ chatId });

      res.json({
        success: true, messages,
        pagination: {
          page, limit, total,
          hasMore: (page - 1) * limit + messages.length < total,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  // ─── Start call ───────────────────────────────────────────────────────────────
  router.post('/start-call', verifyFirebaseToken, async (req, res) => {
    try {
      const { receiverUid, channelName, callType } = req.body;
      const { uid, name, phone_number } = req.user;

      if (!receiverUid || !channelName || !callType) {
        return res.status(400).json({ success: false, error: 'Missing fields' });
      }

      const receiver = await User.findOne({ uid: receiverUid });
      if (!receiver) return res.status(404).json({ success: false, error: 'User not found' });

      const callerName = name || phone_number || 'Unknown';

      // ✅ FIX — only send FCM if the receiver is NOT already connected via socket.
      // Online users already received the call via socket.on('call_user') in server.js.
      // Sending FCM to an online user creates a duplicate notification on Android.
      if (!isUserOnline(receiverUid)) {
        if (!receiver.fcmToken) {
          return res.status(400).json({ success: false, error: 'User unavailable' });
        }
        const result = await sendNotification({
          fcmToken: receiver.fcmToken,
          title:    callType === 'video' ? '📹 Incoming Video Call' : '📞 Incoming Voice Call',
          body:     `${callerName} is calling you...`,
          data: {
            type:        'incoming_call',
            channelName: channelName,
            callType:    callType,
            callerUid:   uid,
            callerName:  callerName,
          },
        });
        if (!result.success) {
          return res.status(500).json({ success: false, error: result.error });
        }
        console.log('✅ Call FCM sent (receiver offline)');
      } else {
        console.log('ℹ️ Receiver online — call delivered via socket, no FCM needed');
      }

      res.json({ success: true, channelName });

    } catch (err) {
      console.error('Start call error:', err);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  // ─── Delete chat history ──────────────────────────────────────────────────────
  router.delete('/history/:chatId', verifyFirebaseToken, async (req, res) => {
    try {
      const { chatId } = req.params;
      const { uid }    = req.user;

      if (!chatId.includes(uid)) {
        return res.status(403).json({ success: false, error: 'Not allowed' });
      }

      const result = await Message.deleteMany({ chatId });
      console.log(`✅ Deleted ${result.deletedCount} messages from ${chatId}`);
      res.json({ success: true, deleted: result.deletedCount });

    } catch (err) {
      console.error('Delete history error:', err);
      res.status(500).json({ success: false, error: 'Server error' });
    }
  });

  module.exports = router;