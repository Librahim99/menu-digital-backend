const mongoose = require("mongoose");

// Bandeja de notificaciones del panel admin. Cada aviso (nuevo registro,
// pago aprobado, prueba) se guarda una vez POR admin destinatario, así el
// estado leído/archivado es de cada uno: que un admin lo lea no lo marca
// como leído para los demás.
//
// Se guarda aunque el backend no tenga Firebase configurado: la bandeja no
// depende de las push, las push son solo el aviso en el dispositivo.
//
// `eventID` es compartido por todas las copias de un mismo aviso y viaja en
// la push: al tocarla, el panel marca como leída la copia del admin que la
// abrió (ver markEventRead en adminNotificationController.js).
const NOTIFICATION_TYPES = [
  "registration",
  "payment",
  "payment_failed",
  "refund",
  "subscription",
  "test",
  "other",
];

// Tipos que cada admin puede silenciar como push (la bandeja los guarda
// igual). "test" y "other" no se ofrecen: la prueba tiene que llegar siempre.
const MUTABLE_TYPES = ["registration", "payment", "payment_failed", "refund", "subscription"];

const DAY_SECONDS = 24 * 60 * 60;
// Limpieza automática: un aviso se borra 90 días después de leerlo o de
// archivarlo. Los no leídos de la bandeja no vencen nunca.
const RETENTION_SECONDS = 90 * DAY_SECONDS;

const adminNotificationSchema = new mongoose.Schema(
  {
    userID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    eventID: { type: String, required: true, index: true },
    type: { type: String, enum: NOTIFICATION_TYPES, default: "other" },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    // Ruta del frontend a la que lleva el aviso (ej. "/admin/payments").
    url: { type: String, default: "/admin" },
    readAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
    // Identifica el hecho que originó el aviso (ej. "refund:<paymentID>")
    // para no repetirlo si el disparador corre dos veces: reintentos del
    // webhook de MercadoPago o la revisión periódica de vencimientos. Sin
    // default a propósito: los avisos sin clave quedan fuera del índice único.
    dedupeKey: { type: String },
  },
  { timestamps: true }
);

// Listado de la bandeja (inbox / archivadas, más nuevas primero) y conteo
// de no leídas, que se consulta cada minuto desde la sidebar.
adminNotificationSchema.index({ userID: 1, archivedAt: 1, createdAt: -1 });
adminNotificationSchema.index({ userID: 1, archivedAt: 1, readAt: 1 });

// Un mismo hecho deja a lo sumo una copia por admin.
adminNotificationSchema.index(
  { userID: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } }
);

// Índices TTL: Mongo ignora los documentos donde el campo no es una fecha,
// así que solo vencen los avisos ya leídos o archivados.
adminNotificationSchema.index({ readAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
adminNotificationSchema.index({ archivedAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

module.exports = mongoose.model("AdminNotification", adminNotificationSchema);
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
module.exports.MUTABLE_TYPES = MUTABLE_TYPES;
