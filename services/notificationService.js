const admin = require('firebase-admin');

// ─── Send to one user ──────────────────────────────────
const sendNotification = async ({ fcmToken, title, body, data = {} }) => {
  try {
    // ✅ all data fields must be strings for FCM
    const stringData = {};
    Object.keys(data).forEach(key => {
      stringData[key] = String(data[key]);
    });

    const message = {
      token: fcmToken,
      notification: { title, body },
      data: {
        ...stringData,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'default',
          priority: 'max',
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
    return { success: true, response };

  } catch (err) {
    console.error('❌ Notification error:', err.message);
    return { success: false, error: err.message };
  }
};

// ─── Send to multiple users ────────────────────────────
const sendNotificationToMany = async ({ fcmTokens, title, body, data = {} }) => {
  try {
    const message = {
      tokens: fcmTokens,
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