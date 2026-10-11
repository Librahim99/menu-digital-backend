const mongoose = require("mongoose");

// Token de Firebase Cloud Messaging de un navegador/dispositivo donde el
// dueño de un local activó los avisos push (pedido nuevo, mesa abierta,
// reserva nueva). Mismo criterio que AdminPushToken, en una colección aparte:
// los avisos del local no se mezclan con los del panel admin.
//
// El token es único: si otro dueño inicia sesión en el mismo navegador, el
// registro se reasigna a él (ver registerToken en ownerPushController.js).
const ownerPushTokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    userID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    userAgent: { type: String, default: null },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("OwnerPushToken", ownerPushTokenSchema);
