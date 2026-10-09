const crypto = require("crypto");
const mongoose = require("mongoose");
const AdminPushToken = require("../models/AdminPushToken");
const AdminPushPreference = require("../models/AdminPushPreference");
const { MUTABLE_TYPES } = require("../models/AdminNotification");
const { isPushEnabled, notifyAdmins } = require("../services/adminPushService");
const { handleError } = require("../utils/handleError");

// Los tokens de FCM rondan los 150-200 caracteres; el tope es solo una red
// de contención contra bodies basura.
const isValidToken = (token) => (
  typeof token === "string" && token.length >= 20 && token.length <= 4096
);

// Huella del token: le permite al panel reconocer cuál de los dispositivos
// de la lista es "este navegador" sin que el token viaje de vuelta.
const fingerprintOf = (token) => crypto.createHash("sha256").update(token).digest("hex");

const deviceToDTO = (device) => ({
  id: String(device._id),
  userAgent: device.userAgent || null,
  fingerprint: fingerprintOf(device.token),
  createdAt: device.createdAt || null,
  lastSeenAt: device.lastSeenAt || null,
});

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

// @desc    Dispositivos del admin logueado que reciben push
// @route   GET /api/admin/push/devices
// @access  Admin
const listDevices = async (req, res) => {
  try {
    const devices = await AdminPushToken.find({ userID: req.user._id })
      .sort({ lastSeenAt: -1 })
      .lean();
    res.json({ devices: devices.map(deviceToDTO) });
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Quita un dispositivo propio (celular perdido, navegador compartido)
// @route   DELETE /api/admin/push/devices/:id
// @access  Admin
const removeDevice = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ message: "Dispositivo no encontrado" });
    }

    // Con userID en el filtro, un ID ajeno se comporta como uno inexistente.
    const result = await AdminPushToken.deleteOne({ _id: id, userID: req.user._id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Dispositivo no encontrado" });
    }
    res.status(204).end();
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Tipos de aviso que el admin silenció como push
// @route   GET /api/admin/push/preferences
// @access  Admin
const getPreferences = async (req, res) => {
  try {
    const preference = await AdminPushPreference.findOne({ userID: req.user._id }).lean();
    res.json({ types: MUTABLE_TYPES, mutedTypes: preference?.mutedTypes || [] });
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Guarda qué tipos de aviso no quiere recibir como push
// @route   PUT /api/admin/push/preferences   body: { mutedTypes: string[] }
// @access  Admin
const updatePreferences = async (req, res) => {
  try {
    const { mutedTypes } = req.body || {};
    if (!Array.isArray(mutedTypes) || !mutedTypes.every((type) => MUTABLE_TYPES.includes(type))) {
      return res.status(400).json({ message: "Tipos de aviso inválidos" });
    }

    const unique = [...new Set(mutedTypes)];
    await AdminPushPreference.findOneAndUpdate(
      { userID: req.user._id },
      { $set: { mutedTypes: unique } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ types: MUTABLE_TYPES, mutedTypes: unique });
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Manda una notificación de prueba a todos los admins y devuelve
//          el resultado real del envío
// @route   POST /api/admin/push/test
// @access  Admin
const sendTestNotification = async (req, res) => {
  try {
    if (!isPushEnabled()) {
      return res.status(503).json({ message: "Las notificaciones push no están configuradas en el servidor" });
    }

    const summary = await notifyAdmins({
      title: "🔔 Notificación de prueba",
      body: `Enviada por ${req.user.username}. Si la ves, las push funcionan.`,
      type: "test",
    });
    if (summary.error) {
      return res.status(502).json({ message: `No se pudo enviar la notificación de prueba: ${summary.error}` });
    }

    const { devices, delivered, failed, removed } = summary.push;
    res.json({ devices, delivered, failed, removed });
  } catch (error) {
    handleError(res, error);
  }
};

module.exports = {
  getPushStatus,
  registerToken,
  removeToken,
  listDevices,
  removeDevice,
  getPreferences,
  updatePreferences,
  sendTestNotification,
};
