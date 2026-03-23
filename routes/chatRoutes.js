const express = require('express');
const router  = express.Router();
const verifyFirebaseToken = require('../middleware/firebaseMiddleware');
const User    = require('../models/User');
const Message = require('../models/Message');
const { sendNotification } = require('../services/notificationService');

// ─── Send Message (FCM fallback) ──────────────────────
router.post('/send-message', verifyFirebaseToken, async (req, res) => {
  try {
    const { receiverUid, message } = req.body;
    const { uid, name, phone_number } = req.user;

    const receiver = await User.findOne({ uid: receiverUid });
    if (!receiver) {
      return res.status(404).json({ success: false, error: 'Receiver not found' });
    }

    if (receiver.fcmToken) {
      await sendNotification({
        fcmToken: receiver.fcmToken,
        title:    name || phone_number || 'New Message',
        body:     message,
        data: {
          type:       'chat_message',
          senderUid:  uid,
          senderName: name || phone_number || '',
        },
      });
    }

    res.json({ success: true, message: 'Message sent!' });

  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ─── Get Chat History ─────────────────────────────────
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
      success: true,
      messages,
      pagination: {
        page, limit, total,
        hasMore: (page - 1) * limit + messages.length < total,
      },
    });

  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ─── Start Call ───────────────────────────────────────
router.post('/start-call', verifyFirebaseToken, async (req, res) => {
  try {
    const { receiverUid, channelName, callType } = req.body;
    const { uid, name, phone_number } = req.user;

    console.log('CALL:', uid, '→', receiverUid, '|', callType, '|', channelName);

    if (!receiverUid || !channelName || !callType) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }

    const receiver   = await User.findOne({ uid: receiverUid });
    if (!receiver)   return res.status(404).json({ success: false, error: 'User not found' });
    if (!receiver.fcmToken) return res.status(400).json({ success: false, error: 'User unavailable' });

    const callerName = name || phone_number || 'Unknown';

    // send FCM for offline users
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

    if (result.success) {
      console.log('✅ Call notification sent');
      res.json({ success: true, channelName });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }

  } catch (err) {
    console.error('Start call error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;