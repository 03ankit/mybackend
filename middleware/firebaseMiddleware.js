const admin = require('firebase-admin');

if (!admin.apps.length) {
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('✅ Firebase loaded from env');
  } else {
    serviceAccount = require('../serviceAccountKey.json');
    console.log('✅ Firebase loaded from file');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const verifyFirebaseToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token       = authHeader.split(' ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);

    req.user = decodedToken;
    next();

  } catch (error) {
    console.error('Token failed:', error.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

module.exports = verifyFirebaseToken;