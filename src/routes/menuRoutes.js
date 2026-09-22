const express = require("express");
const router = express.Router();
const { protect, requireFeature } = require("../middleware/auth");
const { uploadMenu: uploadMenuMiddleware } = require("../config/cloudinary");
const {
  newMenu, editMenu, moveMenu, reorderMenus, hideMenu, deleteMenu, uploadImage, setMenusHiddenBulk, deleteMenusBulk,
} = require("../controllers/menuController");

// Rutas privadas
router.post("/", protect, requireFeature("menu_editor"), newMenu);
// Antes que las rutas con /:menuID para que "reorder" no se lea como un menuID.
router.patch("/reorder", protect, requireFeature("menu_editor"), reorderMenus);
// Mismo motivo: "bulk" no debe leerse como un menuID.
router.patch("/bulk/hidden", protect, requireFeature("menu_editor"), setMenusHiddenBulk);
router.post("/bulk/delete", protect, requireFeature("menu_editor"), deleteMenusBulk);
router.put("/:menuID", protect, requireFeature("menu_editor"), editMenu);
router.patch("/:menuID/move", protect, requireFeature("menu_editor"), moveMenu);
router.patch("/:menuID/hidden", protect, requireFeature("menu_editor"), hideMenu);
router.delete("/:menuID", protect, requireFeature("menu_editor"), deleteMenu);
router.post("/:menuID/upload-image", protect, requireFeature("menu_editor"), uploadMenuMiddleware.single("image"), uploadImage);

module.exports = router;