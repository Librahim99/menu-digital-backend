const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const { uploadMenu: uploadMenuMiddleware } = require("../config/cloudinary");
const {
  newMenu, editMenu, moveMenu, hideMenu, deleteMenu, uploadImage,
} = require("../controllers/menuController");

// Rutas privadas
router.post("/", protect, newMenu);
router.put("/:menuID", protect, editMenu);
router.patch("/:menuID/move", protect, moveMenu);
router.patch("/:menuID/hidden", protect, hideMenu);
router.delete("/:menuID", protect, deleteMenu);
router.post("/:menuID/upload-image", protect, uploadMenuMiddleware.single("image"), uploadImage);

module.exports = router;