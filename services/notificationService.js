// services/notificationService.js
const admin = require('../firebaseAdmin'); // ✅ shared — no duplicate initializeApp

// ─── Send to one user ─────────────────────────────────────────────────────────
// services/notificationService.js
const sendNotification = async ({ fcmToken, title, body, data = {} }) => {
  try {
    const stringData = {};
    Object.keys(data).forEach(key => { stringData[key] = String(data[key]); });

    const message = {
      token: fcmToken,
      // ✅ REMOVED: notification field — was causing Android to auto-show
      // a system notification PLUS your notifee handler showing another one
      data: {
        ...stringData,
        title,   // ✅ pass title/body inside data instead
        body,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
        // No notification sub-key — data-only message, no auto-display
      },
      apns: {
        payload: { aps: { contentAvailable: true } }, // silent on iOS
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
// ─── Send to multiple users ───────────────────────────────────────────────────
const sendNotificationToMany = async ({ fcmTokens, title, body, data = {} }) => {
  try {
    const message = {
      tokens: fcmTokens,
      notification: { title, body },
      data,
      android: { priority: 'high', notification: { sound: 'default' } },
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