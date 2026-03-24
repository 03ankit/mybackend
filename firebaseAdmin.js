// firebaseAdmin.js
// ─── Single source of truth for Firebase Admin SDK ────────────────────────────
// Import this file wherever you need admin — NEVER call initializeApp() elsewhere.

const admin = require('firebase-admin');

if (!admin.apps.length) {
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('✅ Firebase Admin loaded from env');
  } else {
    serviceAccount = require('../serviceAccountKey.json');
    console.log('✅ Firebase Admin loaded from file');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

module.exports = admin;