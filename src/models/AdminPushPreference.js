const mongoose = require("mongoose");
const { MUTABLE_TYPES } = require("./AdminNotification");

// Qué tipos de aviso NO quiere recibir como push cada admin. Solo afecta a
// las push: la bandeja del panel los guarda todos igual. Se guarda aparte de
// User por el mismo motivo que AdminPushToken (ese documento se lee en cada
// request). Sin documento = recibe todo.
const adminPushPreferenceSchema = new mongoose.Schema(
  {
    userID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    mutedTypes: { type: [{ type: String, enum: MUTABLE_TYPES }], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminPushPreference", adminPushPreferenceSchema);
