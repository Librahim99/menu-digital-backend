const mongoose = require("mongoose");

// Código de confirmación de un solo uso para acciones que dependen de probar
// que se controla un email: baja/arrepentimiento (públicas, sin login) antes
// de ejecutar un cambio de estado o reembolso real, y verificacion_email
// (autenticada, ver userController.js) para confirmar la cuenta recién creada.
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const pendingServiceActionSchema = new mongoose.Schema(
  {
    action: { type: String, enum: ["baja", "arrepentimiento", "verificacion_email"], required: true },
    userID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Email real de la cuenta (no el que haya tipeado quien pide la acción):
    // ahí es donde se manda el código.
    email: { type: String, required: true },
    // Solo arrepentimiento: qué transacción de MercadoPago reembolsar al confirmar.
    paymentID: { type: String, default: null },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    consumed: { type: Boolean, default: false },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }, // TTL de Mongo: borra el doc al vencer el código
    },
  },
  { timestamps: true },
);

pendingServiceActionSchema.statics.CODE_TTL_MS = CODE_TTL_MS;
pendingServiceActionSchema.statics.MAX_ATTEMPTS = MAX_ATTEMPTS;

module.exports = mongoose.model(
  "PendingServiceAction",
  pendingServiceActionSchema,
);
