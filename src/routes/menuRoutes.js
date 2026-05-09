const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const { uploadMenu: uploadMenuMiddleware } = require("../config/cloudinary");
const { newMenu, hideMenu, editMenu, uploadImage, uploadMenu } = require("../controllers/menuController");

// ──────────────────────────────────────────────
// Ruta pública: menú de un local por businessName
// Ej: GET /api/menus/public/cafe-roma
// ──────────────────────────────────────────────
router.get("/public/:slug", uploadMenu);

// ──────────────────────────────────────────────
// Rutas privadas
// ──────────────────────────────────────────────
router.post("/", protect, newMenu);
router.put("/:menuID", protect, editMenu);
router.put("/hide/:menuID", protect, hideMenu);
router.post("/:menuID/upload-image", protect, uploadMenuMiddleware.single("image"), uploadImage);
// borrar si está vacio

module.exports = router;