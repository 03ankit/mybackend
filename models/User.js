const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true }, // Firebase UID
  email: { type: String },
  name: { type: String },
  username: { type: String, unique: true, sparse: true },
  language: { type: String },
  photo: { type: String },
  mobile:{type:Number},
  countryCode:{type:String},
  isPhoneVerified:{type:Boolean,default:false},
  fmcToken:{type:String},
  profileComplete: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);