const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const { uploadItem } = require("../config/cloudinary");
const {
  newItem, editItem, moveItem, uploadImage, setHidden, setAvailable, deleteItem
} = require("../controllers/itemController");

router.post("/", protect, newItem);
router.put("/:itemID", protect, editItem);
router.patch("/:itemID/move", protect, moveItem);
router.patch("/:itemID/hidden", protect, setHidden);
router.patch("/:itemID/available", protect, setAvailable);
router.post("/:itemID/upload-image", protect, uploadItem.single("image"), uploadImage);
router.delete("/:itemID", protect, deleteItem);
module.exports = router;