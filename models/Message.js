const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  chatId:      { type: String, required: true }, // unique id for conversation
  senderUid:   { type: String, required: true }, // Firebase uid of sender
  receiverUid: { type: String, required: true }, // Firebase uid of receiver
  text:        { type: String, default: '' },
  type:        { type: String, default: 'text' }, // text, image, file
  read:        { type: Boolean, default: false },
}, { timestamps: true });

// ✅ index for fast query
MessageSchema.index({ chatId: 1, createdAt: 1 });

module.exports = mongoose.model('Message', MessageSchema);