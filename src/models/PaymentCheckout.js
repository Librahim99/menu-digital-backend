const mongoose = require("mongoose");

// Snapshot durable e inmutable de las condiciones ofrecidas antes de enviar
// al comprador a MercadoPago. Permite validar el pago sin depender de precios
// o metadata que puedan cambiar después.
const paymentCheckoutSchema = new mongoose.Schema(
  {
    // Sin default para que el índice sparse no indexe varios `null` mientras
    // MercadoPago todavía no devolvió el identificador de preferencia.
    preferenceId: { type: String, trim: true },
    initPoint: { type: String, default: null, trim: true },
    operation: {
      type: String,
      enum: ["registration", "upgrade", "renewal"],
      required: true,
      immutable: true,
    },
    userID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      immutable: true,
    },
    pendingRegistrationID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PendingRegistration",
      default: null,
      immutable: true,
    },
    planId: {
      type: String,
      enum: ["basic", "pro"],
      required: true,
      immutable: true,
    },
    months: {
      type: Number,
      enum: [1, 3, 6, 12],
      required: true,
      immutable: true,
    },
    expectedAmount: { type: Number, required: true, min: 0, immutable: true },
    currency: {
      type: String,
      required: true,
      default: "ARS",
      trim: true,
      immutable: true,
    },
    sourcePlan: {
      type: String,
      enum: ["free", "basic", "pro"],
      default: null,
      immutable: true,
    },
    sourceExpiresAt: { type: Date, default: null, immutable: true },
    status: {
      type: String,
      enum: ["creating", "ready", "superseded", "failed", "payment_received"],
      default: "creating",
    },
    failureReason: { type: String, default: null, trim: true },
  },
  { timestamps: true }
);

paymentCheckoutSchema.index({ preferenceId: 1 }, { unique: true, sparse: true });
paymentCheckoutSchema.index({ userID: 1, createdAt: -1 });
paymentCheckoutSchema.index({ pendingRegistrationID: 1, createdAt: -1 });

module.exports = mongoose.model("PaymentCheckout", paymentCheckoutSchema);
