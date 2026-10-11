const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const {
  getPushStatus,
  registerToken,
  removeToken,
  sendTestNotification,
} = require("../controllers/ownerPushController");

// Avisos push del dueño del local (pedido nuevo, mesa abierta, reserva nueva).
router.get("/status", protect, getPushStatus);
router.post("/tokens", protect, registerToken);
router.delete("/tokens", protect, removeToken);
router.post("/test", protect, sendTestNotification);

module.exports = router;
