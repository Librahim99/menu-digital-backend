const mongoose = require("mongoose");

const pendingRegistrationSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, trim: true },
    password: { type: String, required: true }, // en texto; el pre-save de User la hashea al crear
    contactInfo: {
      mail: { type: String, required: true },
      businessName: { type: String, required: true },
    },
    acceptedTerms: { type: Boolean, required: true },
    planId: { type: String, enum: ["basic", "pro"], required: true },
    months: { type: Number, enum: [1, 3, 6, 12], required: true },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
      index: { expires: 0 }, // TTL de Mongo: borra el doc cuando llega la fecha
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PendingRegistration", pendingRegistrationSchema);