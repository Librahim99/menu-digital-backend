const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const { uploadItem } = require("../config/cloudinary");
const {
  newItem,
  editItem,
  editItemMassive,
  uploadImage,
  setHidden,
  setAvailable,
} = require("../controllers/itemController");

// Todas las rutas de items son privadas
router.post("/", protect, newItem);
router.put("/massive", protect, editItemMassive); //modificar para usar un excel      // Antes que /:itemID para no colisionar
router.put("/:itemID", protect, editItem);
router.post("/:itemID/upload-image", protect, uploadItem.single("image"), uploadImage);
router.patch("/:itemID/hidden", protect, setHidden);
router.patch("/:itemID/available", protect, setAvailable);

module.exports = router;