const express = require('express');
const router = express.Router();
const verifyFirebaseToken = require('../middleware/firebaseMiddleware');
const User = require('../models/User');
const { sendNotification } = require('../services/notificationService');

// send message + push notification
router.post('/send-message', verifyFirebaseToken, async (req, res) => {
  try {
    const { receiverUid, message } = req.body;
    const { uid, name } = req.user;

    const receiver = await User.findOne({ uid: receiverUid });

    if (!receiver) {
      return res.status(404).json({ success: false, error: 'Receiver not found' });
    }

    if (receiver.fcmToken) {
      await sendNotification({
        fcmToken: receiver.fcmToken,
        title: name || 'New Message',
        body: message,
        data: {
          type: 'chat_message',
          senderUid: uid,
          senderName: name || '',
        },
      });
    }

    res.json({ success: true, message: 'Message sent!' });

  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;