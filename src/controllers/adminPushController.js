const AdminPushToken = require("../models/AdminPushToken");
const { isPushEnabled, notifyAdmins } = require("../services/adminPushService");
const { handleError } = require("../utils/handleError");

// Los tokens de FCM rondan los 150-200 caracteres; el tope es solo una red
// de contención contra bodies basura.
const isValidToken = (token) => (
  typeof token === "string" && token.length >= 20 && token.length <= 4096
);

// @desc    Estado de las push (si el backend tiene Firebase configurado)
// @route   GET /api/admin/push/status
// @access  Admin
const getPushStatus = async (req, res) => {
  try {
    const devices = await AdminPushToken.countDocuments({ userID: req.user._id });
    res.json({ enabled: isPushEnabled(), devices });
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Registra (o reasigna) el token FCM del navegador del admin
// @route   POST /api/admin/push/tokens
// @access  Admin
const registerToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!isValidToken(token)) {
      return res.status(400).json({ message: "Token de notificaciones inválido" });
    }

    await AdminPushToken.findOneAndUpdate(
      { token },
      {
        $set: {
          userID: req.user._id,
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

// @desc    Da de baja el token del navegador actual (desactivar / logout)
// @route   DELETE /api/admin/push/tokens
// @access  Admin
const removeToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!isValidToken(token)) {
      return res.status(400).json({ message: "Token de notificaciones inválido" });
    }

    // Solo el propio admin puede borrar sus tokens.
    await AdminPushToken.deleteOne({ token, userID: req.user._id });
    res.status(204).end();
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Manda una notificación de prueba a todos los admins
// @route   POST /api/admin/push/test
// @access  Admin
const sendTestNotification = async (req, res) => {
  try {
    if (!isPushEnabled()) {
      return res.status(503).json({ message: "Las notificaciones push no están configuradas en el servidor" });
    }

    await notifyAdmins({
      title: "🔔 Notificación de prueba",
      body: `Enviada por ${req.user.username}. Si la ves, las push funcionan.`,
      type: "test",
    });
    res.status(204).end();
  } catch (error) {
    handleError(res, error);
  }
};

module.exports = { getPushStatus, registerToken, removeToken, sendTestNotification };
