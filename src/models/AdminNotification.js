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
const NOTIFICATION_TYPES = ["registration", "payment", "test", "other"];

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
  },
  { timestamps: true }
);

// Listado de la bandeja (inbox / archivadas, más nuevas primero) y conteo
// de no leídas, que se consulta cada minuto desde la sidebar.
adminNotificationSchema.index({ userID: 1, archivedAt: 1, createdAt: -1 });
adminNotificationSchema.index({ userID: 1, archivedAt: 1, readAt: 1 });

module.exports = mongoose.model("AdminNotification", adminNotificationSchema);
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
