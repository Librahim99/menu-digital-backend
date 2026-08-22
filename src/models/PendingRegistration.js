const mongoose = require("mongoose");

const CHECKOUT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PAYMENT_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = CHECKOUT_TTL_MS + PAYMENT_GRACE_MS;
const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;

const getCheckoutExpiration = (now = Date.now()) =>
  new Date(now + CHECKOUT_TTL_MS);

const getPendingExpiration = (now = Date.now()) =>
  new Date(now + PENDING_TTL_MS);

const getTerminalExpiration = (now = Date.now()) =>
  new Date(now + TERMINAL_TTL_MS);

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
    // sparse permite desplegar el índice aunque todavía existan registros
    // pendientes creados antes de incorporar este token.
    activationTokenHash: { type: String, required: true, unique: true, sparse: true },
    // Se conserva la preferencia para que volver atrás o reintentar no cree
    // otro checkout cobrable. Si cambia plan/período, se actualiza esta misma.
    preferenceId: { type: String, default: null },
    initPoint: { type: String, default: null },
    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
    },
    // Estado propio de MercadoPago. Se guarda separado de `status` porque un
    // pago rechazado puede reintentarse con la misma preferencia mientras el
    // alta interna todavía sigue pendiente.
    paymentID: { type: String, default: null },
    paymentStatus: { type: String, default: null },
    paymentStatusDetail: { type: String, default: null },
    paymentUpdatedAt: { type: Date, default: null },
    userID: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    completedAt: { type: Date, default: null },
    expiresAt: {
      type: Date,
      // El checkout vence a los 7 días. Conservamos el alta 3 días más
      // para que un pago iniciado cerca del vencimiento tenga margen de
      // acreditación; al completarse o fallar, el webhook acorta este plazo
      // a 24 horas.
      default: getPendingExpiration,
      index: { expires: 0 }, // TTL de Mongo: borra el doc cuando llega la fecha
    },
  },
  { timestamps: true }
);

pendingRegistrationSchema.statics.getCheckoutExpiration = getCheckoutExpiration;
pendingRegistrationSchema.statics.getPendingExpiration = getPendingExpiration;
pendingRegistrationSchema.statics.getTerminalExpiration = getTerminalExpiration;

module.exports = mongoose.model("PendingRegistration", pendingRegistrationSchema);
