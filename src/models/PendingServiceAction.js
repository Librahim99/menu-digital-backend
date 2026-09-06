const mongoose = require("mongoose");

// Código de confirmación de un solo uso para acciones que dependen de probar
// que se controla un email: baja/arrepentimiento (públicas, sin login) antes
// de ejecutar un cambio de estado o reembolso real; verificacion_email
// (autenticada) para confirmar la cuenta recién creada; y cambio_email
// (autenticada) para confirmar un mail de contacto nuevo antes de guardarlo.
// Todo en userController.js/paymentController.js.
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const pendingServiceActionSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: ["baja", "arrepentimiento", "verificacion_email", "cambio_email"],
      required: true,
    },
    userID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // El mail al que se manda el código: para baja/arrepentimiento/
    // verificacion_email es el mail REAL de la cuenta (nunca el que haya
    // tipeado quien pide la acción); para cambio_email es el mail NUEVO que
    // todavía no se guardó — confirmEmailChange lo lee de acá para recién
    // ahí escribirlo en contactInfo.mail.
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
