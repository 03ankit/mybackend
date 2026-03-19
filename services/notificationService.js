const admin = require('firebase-admin');

// ─── Send to one user ──────────────────────────────────
const sendNotification = async ({ fcmToken, title, body, data = {} }) => {
  try {
    const message = {
      token: fcmToken,
      notification: {
        title,
        body,
      },
      data: {
        ...data,
        // data fields must be strings
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'default',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    const response = await admin.messaging().send(message);
    console.log('✅ Notification sent:', response);
    return { success: true };

  } catch (err) {
    console.error('❌ Notification error:', err.message);
    return { success: false, error: err.message };
  }
};

// ─── Send to multiple users ────────────────────────────
const sendNotificationToMany = async ({ fcmTokens, title, body, data = {} }) => {
  try {
    const message = {
      tokens: fcmTokens, // array of tokens
      notification: { title, body },
      data,
      android: {
        priority: 'high',
        notification: { sound: 'default' },
      },
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`✅ Sent: ${response.successCount}, Failed: ${response.failureCount}`);
    return { success: true, response };

  } catch (err) {
    console.error('❌ Multicast error:', err.message);
    return { success: false, error: err.message };
  }
};

module.exports = { sendNotification, sendNotificationToMany };