const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middleware/auth");

const  {
  getSellers,
  getSellerById,
  createSeller,
  updateSeller,
  deleteSeller,
  validateSellerCode
} = require("../controllers/sellerController.js");
// Obtener todos
router.get("/", protect, isAdmin, getSellers);

// Obtener por ID
router.get("/:id", protect, isAdmin, getSellerById);

// Crear
router.post("/", protect, isAdmin, createSeller);

// Modificar
router.put("/:id", protect, isAdmin, updateSeller);

// Eliminar
router.delete("/:id", protect, isAdmin, deleteSeller);


module.exports = router;
