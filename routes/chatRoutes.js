const express = require('express');
const router = express.Router();
const verifyFirebaseToken = require('../middleware/firebaseMiddleware');
const User = require('../models/User');
const { sendNotification } = require('../services/notificationService');

// ─── Send Message ─────────────────────────────────────
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
        title: name || phone_number || 'New Message',
        body: message,
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

// ─── Start Call ───────────────────────────────────────
router.post('/start-call', verifyFirebaseToken, async (req, res) => {
  try {
    const { receiverUid, channelName, callType } = req.body;
    const { uid, name, phone_number } = req.user;

    console.log('═══════════════════════════════');
    console.log('CALL from:', uid);
    console.log('CALL to:', receiverUid);
    console.log('Channel:', channelName);
    console.log('Type:', callType);
    console.log('═══════════════════════════════');

    if (!receiverUid || !channelName || !callType) {
      return res.status(400).json({
        success: false,
        error: 'receiverUid, channelName and callType are required'
      });
    }

    // find receiver
    const receiver = await User.findOne({ uid: receiverUid });

    if (!receiver) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (!receiver.fcmToken) {
      return res.status(400).json({ success: false, error: 'User is unavailable' });
    }

    const callerName = name || phone_number || 'Unknown';

    // ✅ send incoming call notification
    const result = await sendNotification({
      fcmToken: receiver.fcmToken,
      title: callType === 'video' ? '📹 Incoming Video Call' : '📞 Incoming Voice Call',
      body:  `${callerName} is calling you...`,
      data: {
        type:        'incoming_call',
        channelName: channelName,
        callType:    callType,
        callerUid:   uid,
        callerName:  callerName,
      },
    });

    if (result.success) {
      console.log('✅ Call notification sent to:', receiver.phone || receiver.email);
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