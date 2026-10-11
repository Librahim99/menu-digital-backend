const OwnerPushToken = require("../models/OwnerPushToken");
const { OWNER_PUSH_FEATURES } = require("../models/OwnerPushToken");
const { isPushEnabled } = require("../services/adminPushService");
const { notifyOwner } = require("../services/ownerPushService");
const { handleError } = require("../utils/handleError");

// Avisos push del dueño del local (pedidos, mesas, reservas). Mismo esquema
// que las push del admin (adminPushController.js) pero cada dueño solo
// maneja y recibe lo suyo.

const isValidToken = (token) => (
  typeof token === "string" && token.length >= 20 && token.length <= 4096
);

// @desc    Si el servidor puede mandar push y cuántos dispositivos tiene el local
// @route   GET /api/push/status
// @access  Dueño
const getPushStatus = async (req, res) => {
  try {
    const devices = await OwnerPushToken.countDocuments({ userID: req.user._id, features: { $exists: true, $ne: [] } });
    res.json({ enabled: isPushEnabled(), devices });
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Registra (o reasigna) el token FCM de este navegador y qué
//          features avisa (Pedidos, Reservas). Sin features no se guarda.
// @route   POST /api/push/tokens   body: { token, features: ["orders"|"reservations"] }
// @access  Dueño
const registerToken = async (req, res) => {
  try {
    const { token, features = [] } = req.body || {};
    if (!isValidToken(token)) {
      return res.status(400).json({ message: "Token de notificaciones inválido" });
    }
    if (!Array.isArray(features) || !features.every((feature) => OWNER_PUSH_FEATURES.includes(feature))) {
      return res.status(400).json({ message: "Avisos inválidos" });
    }
    // Ningún feature activado: el dispositivo deja de recibir avisos.
    if (features.length === 0) {
      await OwnerPushToken.deleteOne({ token, userID: req.user._id });
      return res.status(204).end();
    }
    await OwnerPushToken.findOneAndUpdate(
      { token },
      {
        $set: {
          userID: req.user._id,
          features: [...new Set(features)],
          userAgent: String(req.get("user-agent") || "").slice(0, 300) || null,
          lastSeenAt: new Date(),
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    res.status(204).end();
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Da de baja el token de este navegador
// @route   DELETE /api/push/tokens
// @access  Dueño
const removeToken = async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!isValidToken(token)) {
      return res.status(400).json({ message: "Token de notificaciones inválido" });
    }
    await OwnerPushToken.deleteOne({ token, userID: req.user._id });
    res.status(204).end();
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Manda un aviso de prueba a los dispositivos del local
// @route   POST /api/push/test
// @access  Dueño
const sendTestNotification = async (req, res) => {
  try {
    if (!isPushEnabled()) {
      return res.status(503).json({ message: "Las notificaciones push no están configuradas en el servidor" });
    }
    const summary = await notifyOwner(String(req.user._id), {
      title: "🔔 Aviso de prueba",
      body: "Así te van a llegar los pedidos, las mesas y las reservas nuevas.",
      url: "/pedidos",
      tag: "test",
    });
    if (summary.error) {
      return res.status(502).json({ message: `No se pudo enviar el aviso de prueba: ${summary.error}` });
    }
    const { devices, delivered, failed, removed } = summary;
    res.json({ devices, delivered, failed, removed });
  } catch (error) {
    handleError(res, error);
  }
};

module.exports = { getPushStatus, registerToken, removeToken, sendTestNotification };
