const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middleware/auth");
const {
  getPushStatus,
  registerToken,
  removeToken,
  sendTestNotification,
} = require("../controllers/adminPushController");

// Notificaciones push de Firebase: exclusivas de usuarios admin.
router.get("/status", protect, isAdmin, getPushStatus);
router.post("/tokens", protect, isAdmin, registerToken);
router.delete("/tokens", protect, isAdmin, removeToken);
router.post("/test", protect, isAdmin, sendTestNotification);

module.exports = router;
