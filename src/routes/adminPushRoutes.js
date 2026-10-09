const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middleware/auth");
const {
  getPushStatus,
  registerToken,
  removeToken,
  listDevices,
  removeDevice,
  getPreferences,
  updatePreferences,
  sendTestNotification,
} = require("../controllers/adminPushController");

// Notificaciones push de Firebase: exclusivas de usuarios admin.
router.get("/status", protect, isAdmin, getPushStatus);
router.post("/tokens", protect, isAdmin, registerToken);
router.delete("/tokens", protect, isAdmin, removeToken);
router.get("/devices", protect, isAdmin, listDevices);
router.delete("/devices/:id", protect, isAdmin, removeDevice);
router.get("/preferences", protect, isAdmin, getPreferences);
router.put("/preferences", protect, isAdmin, updatePreferences);
router.post("/test", protect, isAdmin, sendTestNotification);

module.exports = router;
