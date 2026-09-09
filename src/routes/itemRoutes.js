const express = require("express");
const router = express.Router();
const { protect, requireFeature } = require("../middleware/auth");
const { imageUploadLimiter } = require("../middleware/rateLimiters");
const { uploadItem, uploadItemLibrary } = require("../config/cloudinary");
const {
  newItem, editItem, moveItem, uploadImage, uploadDraftImage, setHidden, setAvailable, deleteItem,
  setAvailableBulk, setHiddenBulk, deleteItemsBulk,
  getLiteItems, getPendingImages, checkImageQuota, uploadLibraryImage, assignImages, deleteLibraryImage
} = require("../controllers/itemController");

router.post("/", protect, requireFeature("menu_editor"), newItem);
// Antes que /:itemID/upload-image no hace falta (los paths no chocan), pero sí
// antes de cualquier ruta con comodín para que "upload-image" no se lea como
// un itemID.
router.post("/upload-image", protect, requireFeature("menu_editor"), uploadItem.single("image"), uploadDraftImage);
// Las rutas /bulk/* van antes que /:itemID/* por el mismo motivo: si no,
// "bulk" se leería como itemID y quedarían tapadas.
router.patch("/bulk/available", protect, requireFeature("menu_editor"), setAvailableBulk);
router.patch("/bulk/hidden", protect, requireFeature("menu_editor"), setHiddenBulk);
router.post("/bulk/delete", protect, requireFeature("menu_editor"), deleteItemsBulk);
// Gestor de imágenes — mismo motivo, van antes de /:itemID/*. Gateadas por
// la feature "image_manager" (no "menu_editor": es su propio feature de
// plan, configurable aparte desde el catálogo).
router.get("/lite", protect, requireFeature("image_manager"), getLiteItems);
router.get("/images/pending", protect, requireFeature("image_manager"), getPendingImages);
router.post(
  "/images/upload", protect, requireFeature("image_manager"), imageUploadLimiter, checkImageQuota,
  uploadItemLibrary.single("image"), uploadLibraryImage
);
router.post("/images/assign", protect, requireFeature("image_manager"), assignImages);
// DELETE /images antes de DELETE /:itemID por el mismo motivo que el resto
// de las rutas de arriba: si no, "images" se leería como itemID.
router.delete("/images", protect, requireFeature("image_manager"), deleteLibraryImage);
router.put("/:itemID", protect, requireFeature("menu_editor"), editItem);
router.patch("/:itemID/move", protect, requireFeature("menu_editor"), moveItem);
router.patch("/:itemID/hidden", protect, requireFeature("menu_editor"), setHidden);
router.patch("/:itemID/available", protect, requireFeature("menu_editor"), setAvailable);
router.post("/:itemID/upload-image", protect, requireFeature("menu_editor"), uploadItem.single("image"), uploadImage);
router.delete("/:itemID", protect, requireFeature("menu_editor"), deleteItem);
module.exports = router;