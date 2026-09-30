const mongoose = require("mongoose");

// Token de Firebase Cloud Messaging de un navegador/dispositivo donde un
// admin activó las notificaciones push. Un mismo admin puede tener varios
// (PC + celular). Se guarda aparte de User para no engordar ese documento,
// que se lee en cada request (middleware protect).
//
// El token es único: si otro admin inicia sesión en el mismo navegador, el
// registro se reasigna a él (ver registerToken en adminPushController.js).
const adminPushTokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    userID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    userAgent: { type: String, default: null },
    // Se refresca cada vez que el panel vuelve a registrar el token; sirve
    // para limpiar a mano dispositivos que nadie usa hace meses.
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminPushToken", adminPushTokenSchema);
