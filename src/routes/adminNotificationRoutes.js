const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middleware/auth");
const {
  listNotifications,
  getUnreadCount,
  openNotification,
  updateNotification,
  deleteNotification,
  bulkUpdateNotifications,
  markAllRead,
  markEventRead,
} = require("../controllers/adminNotificationController");

// Bandeja de notificaciones del panel admin (cada admin ve las suyas).
router.use(protect, isAdmin);
router.get("/", listNotifications);
// Las rutas fijas van antes que /:id para que no las capture.
router.get("/unread-count", getUnreadCount);
router.post("/bulk", bulkUpdateNotifications);
router.post("/read-all", markAllRead);
router.post("/events/:eventID/read", markEventRead);
router.get("/:id", openNotification);
router.patch("/:id", updateNotification);
router.delete("/:id", deleteNotification);

module.exports = router;
