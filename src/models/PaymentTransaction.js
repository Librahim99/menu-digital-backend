const mongoose = require("mongoose");

// Historial durable de pagos consultados a MercadoPago. A diferencia de
// PendingRegistration, esta colección no tiene TTL: debe sobrevivir para
// auditoría, conciliación y soporte.
const paymentTransactionSchema = new mongoose.Schema(
  {
    paymentID: { type: String, required: true, unique: true, trim: true },
    checkoutID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PaymentCheckout",
      default: null,
    },
    preferenceId: { type: String, default: null, trim: true },
    merchantOrderID: { type: String, default: null, trim: true },
    externalReference: { type: String, default: null, trim: true },
    userID: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    pendingRegistrationID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PendingRegistration",
      default: null,
    },
    operation: {
      type: String,
      enum: ["registration", "upgrade", "renewal", "unknown"],
      default: "unknown",
    },
    // Estos valores vienen de metadata externa. No llevan enum para que un
    // pago con metadata inválida igual quede auditado y no provoque un ciclo
    // permanente de respuestas 500 del webhook.
    planId: { type: String, default: null, trim: true },
    months: { type: Number, default: null },
    amount: { type: Number, default: null },
    refundedAmount: { type: Number, default: null },
    currency: { type: String, default: null, trim: true },
    status: { type: String, default: null, trim: true },
    statusDetail: { type: String, default: null, trim: true },
    liveMode: { type: Boolean, default: null },
    paymentCreatedAt: { type: Date, default: null },
    paymentApprovedAt: { type: Date, default: null },
    paymentUpdatedAt: { type: Date, default: null },
    lastWebhookAt: { type: Date, required: true },
    entitlementStatus: {
      type: String,
      enum: ["pending", "not_applied", "applied"],
      default: "pending",
    },
    entitlementReason: { type: String, default: null, trim: true },
    entitlementAppliedAt: { type: Date },
    entitlementAttemptedAt: { type: Date },
    checkoutValidation: {
      type: String,
      enum: ["strict", "legacy", "failed"],
      default: "legacy",
    },
    checkoutValidationReason: { type: String, default: null, trim: true },
    appliedPlanId: { type: String, enum: ["basic", "pro"] },
    appliedMonths: { type: Number, enum: [1, 3, 6, 12] },
    // Sin default: `null` significa realmente que antes no había vencimiento;
    // campo ausente significa que el contexto todavía no fue capturado.
    subscriptionExpiresAtBefore: { type: Date },
    subscriptionExpiresAtAfter: { type: Date },
  },
  { timestamps: true }
);

paymentTransactionSchema.index({ userID: 1, createdAt: -1 });
paymentTransactionSchema.index({ pendingRegistrationID: 1, createdAt: -1 });
paymentTransactionSchema.index({ preferenceId: 1 });

module.exports = mongoose.model("PaymentTransaction", paymentTransactionSchema);
