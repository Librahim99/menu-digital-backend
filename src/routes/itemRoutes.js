const express = require("express");
const router = express.Router();
const { protect, requireFeature } = require("../middleware/auth");
const { uploadItem } = require("../config/cloudinary");
const {
  newItem, editItem, moveItem, uploadImage, uploadDraftImage, setHidden, setAvailable, deleteItem
} = require("../controllers/itemController");

router.post("/", protect, requireFeature("menu_editor"), newItem);
// Antes que /:itemID/upload-image no hace falta (los paths no chocan), pero sí
// antes de cualquier ruta con comodín para que "upload-image" no se lea como
// un itemID.
router.post("/upload-image", protect, requireFeature("menu_editor"), uploadItem.single("image"), uploadDraftImage);
router.put("/:itemID", protect, requireFeature("menu_editor"), editItem);
router.patch("/:itemID/move", protect, requireFeature("menu_editor"), moveItem);
router.patch("/:itemID/hidden", protect, requireFeature("menu_editor"), setHidden);
router.patch("/:itemID/available", protect, requireFeature("menu_editor"), setAvailable);
router.post("/:itemID/upload-image", protect, requireFeature("menu_editor"), uploadItem.single("image"), uploadImage);
router.delete("/:itemID", protect, requireFeature("menu_editor"), deleteItem);
module.exports = router;