const express = require("express");
const router = express.Router();
const { protect, requireFeature } = require("../middleware/auth");
const { uploadMenu: uploadMenuMiddleware } = require("../config/cloudinary");
const {
  newMenu, editMenu, moveMenu, reorderMenus, hideMenu, deleteMenu, uploadImage,
} = require("../controllers/menuController");

// Rutas privadas
router.post("/", protect, requireFeature("menu_editor"), newMenu);
// Antes que las rutas con /:menuID para que "reorder" no se lea como un menuID.
router.patch("/reorder", protect, requireFeature("menu_editor"), reorderMenus);
router.put("/:menuID", protect, requireFeature("menu_editor"), editMenu);
router.patch("/:menuID/move", protect, requireFeature("menu_editor"), moveMenu);
router.patch("/:menuID/hidden", protect, requireFeature("menu_editor"), hideMenu);
router.delete("/:menuID", protect, requireFeature("menu_editor"), deleteMenu);
router.post("/:menuID/upload-image", protect, requireFeature("menu_editor"), uploadMenuMiddleware.single("image"), uploadImage);

module.exports = router;