const express = require("express");
const router = express.Router();
const { protect, requireFeature } = require("../middleware/auth");
const { uploadMenu: uploadMenuMiddleware } = require("../config/cloudinary");
const {
  newMenu, editMenu, moveMenu, hideMenu, deleteMenu, uploadImage,
} = require("../controllers/menuController");

// Rutas privadas
router.post("/", protect, requireFeature("menu_editor"), newMenu);
router.put("/:menuID", protect, requireFeature("menu_editor"), editMenu);
router.patch("/:menuID/move", protect, requireFeature("menu_editor"), moveMenu);
router.patch("/:menuID/hidden", protect, requireFeature("menu_editor"), hideMenu);
router.delete("/:menuID", protect, requireFeature("menu_editor"), deleteMenu);
router.post("/:menuID/upload-image", protect, requireFeature("menu_editor"), uploadMenuMiddleware.single("image"), uploadImage);

module.exports = router;