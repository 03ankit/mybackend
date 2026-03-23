const express = require('express');
const router  = express.Router();
const verifyFirebaseToken = require('../middleware/firebaseMiddleware');
const User = require('../models/User');

// ─── Login ────────────────────────────────────────────
router.post('/login', verifyFirebaseToken, async (req, res) => {
  try {
    const { uid, email, name, picture, phone_number } = req.user;
    const phone = phone_number || req.body.phone || null;

    console.log('LOGIN uid:', uid, '| phone:', phone);

    let user = await User.findOne({ uid });

    if (!user) {
      user = await User.create({
        uid,
        email:           email   || null,
        name:            name    || null,
        photo:           picture || null,
        phone,
        isPhoneVerified: !!phone,
        profileComplete: false,
      });
      return res.json({ success: true, isNewUser: true, user });
    }

    const updatedUser = await User.findOneAndUpdate(
      { uid },
      { $set: { phone, isPhoneVerified: !!phone } },
      { new: true }
    );

    return res.json({ success: true, isNewUser: false, user: updatedUser });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ─── Setup Profile ────────────────────────────────────
router.post('/setup-profile', verifyFirebaseToken, async (req, res) => {
  try {
    const { name, username, language } = req.body;
    const { uid } = req.user;

    const existing = await User.findOne({ username });
    if (existing && existing.uid !== uid) {
      return res.json({ success: false, error: 'Username already taken' });
    }

    const user = await User.findOneAndUpdate(
      { uid },
      { $set: { name, username, language, profileComplete: true } },
      { new: true, upsert: true }
    );

    res.json({ success: true, user });

  } catch (err) {
    console.error('Setup profile error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ─── Get My Profile ───────────────────────────────────
router.get('/me', verifyFirebaseToken, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.user.uid });
    if (!user) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ─── Save FCM Token ───────────────────────────────────
router.post('/save-fcm-token', verifyFirebaseToken, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    const { uid }      = req.user;

    await User.findOneAndUpdate({ uid }, { fcmToken }, { new: true });

    console.log('✅ FCM saved for:', uid);
    res.json({ success: true, message: 'FCM token saved' });

  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ─── Get All Users ────────────────────────────────────
router.get('/users', verifyFirebaseToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const users   = await User.find(
      { uid: { $ne: uid }, profileComplete: true },
      { uid: 1, name: 1, username: 1, phone: 1, photo: 1, fcmToken: 1 }
    );
    console.log('✅ Users fetched:', users.length);
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ─── Test Notification ────────────────────────────────
router.post('/test-notification', async (req, res) => {
  try {
    const { fcmToken, title, body, ...extraData } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ success: false, error: 'fcmToken required' });
    }

    const { sendNotification } = require('../services/notificationService');

    const result = await sendNotification({
      fcmToken,
      title: title || '🔔 Test',
      body:  body  || 'Notification working!',
      data: {
        type:        extraData.type        || 'chat_message',
        chatId:      extraData.chatId      || '',
        channelName: extraData.channelName || '',
        callType:    extraData.callType    || '',
        callerName:  extraData.callerName  || '',
        callerUid:   extraData.callerUid   || '',
      },
    });

    if (result.success) {
      res.json({ success: true, message: 'Sent!' });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;