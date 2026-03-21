const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  uid:             { type: String, required: true, unique: true },
  email:           { type: String, default: null },
  name:            { type: String, default: null },
  username:        { type: String, unique: true, sparse: true },
  language:        { type: String, default: null },
  photo:           { type: String, default: null },
  phone:           { type: String, default: null },
  countryCode:     { type: String, default: null },
  status:          { type: String, default: '' },
  fcmToken:        { type: String, default: null }, // ✅ fixed typo: was fmcToken
  isPhoneVerified: { type: Boolean, default: false },
  profileComplete: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);