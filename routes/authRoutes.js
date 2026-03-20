const express = require('express');
const router = express.Router();
const verifyFirebaseToken = require('../middleware/firebaseMiddleware');
const User = require('../models/User');

// Login — Google + OTP both use this
router.post('/login', verifyFirebaseToken, async (req, res) => {
  try {
    const { uid, email, name, picture, phone_number } = req.user;
    const phone = phone_number || req.body.phone || null;

    console.log('uid:', uid);
    console.log('phone_number from token:', phone_number);
    console.log('phone from body:', req.body.phone);
    console.log('phone used:', phone);

    let user = await User.findOne({ uid });

    if (!user) {
      // ✅ new user
      user = await User.create({
        uid,
        email:           email   || null,
        name:            name    || null,
        photo:           picture || null,
        phone:           phone,
        isPhoneVerified: !!phone,
        profileComplete: false,
      });
      console.log('✅ New user created, phone:', user.phone);
      return res.json({ success: true, isNewUser: true, user });
    }

    // ✅ existing user — update phone if missing
    if (phone && !user.phone) {
      user = await User.findOneAndUpdate(
        { uid },
        { $set: { phone, isPhoneVerified: true } },
        { new: true } // ← returns updated user
      );
      console.log('✅ Phone saved:', phone);
    }

    // ✅ always return latest user data
    console.log('✅ Existing user, phone:', user.phone);
    return res.json({ success: true, isNewUser: false, user });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Setup Profile
router.post('/setup-profile', verifyFirebaseToken, async (req, res) => {
  try {
    const { name, username, language } = req.body;
    const { uid } = req.user;

    const existingUsername = await User.findOne({ username });
    if (existingUsername && existingUsername.uid !== uid) {
      return res.json({ success: false, error: 'Username already taken' });
    }

    const user = await User.findOneAndUpdate(
      { uid },
      { name, username, language, profileComplete: true },
      { new: true, upsert: true }
    );

    res.json({ success: true, user });

  } catch (err) {
    console.error('Setup profile error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Get my profile
router.get('/me', verifyFirebaseToken, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.user.uid });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// save FCM token
router.post('/save-fcm-token', verifyFirebaseToken, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    const { uid } = req.user;

    await User.findOneAndUpdate(
      { uid },
      { fcmToken },
      { new: true }
    );

    console.log('✅ FCM token saved for uid:', uid);
    res.json({ success: true, message: 'FCM token saved' });

  } catch (err) {
    console.error('FCM token save error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// test notification route
router.post('/test-notification', async (req, res) => {
  try {
    const { fcmToken, title, body } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ success: false, error: 'fcmToken is required' });
    }

    const { sendNotification } = require('../services/notificationService');

    const result = await sendNotification({
      fcmToken,
      title: title || '🔔 Test Notification',
      body: body || 'Backend notification is working!',
      data: {
        type: 'chat_message',
        chatId: '1',
      },
    });

    if (result.success) {
      console.log('✅ Test notification sent!');
      res.json({ success: true, message: 'Notification sent!' });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }

  } catch (err) {
    console.error('Test notification error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router; // ← keep this at bottom