const express = require("express");
const router = express.Router();
const { protect, isAdmin, protectSellerOrAdmin } = require("../middleware/auth");

const  {
  getSellers,
  getSellerById,
  createSeller,
  updateSeller,
  deleteSeller,
} = require("../controllers/sellerController.js");
// Obtener todos
router.get("/", protect, isAdmin, getSellers);

// Obtener por ID — admin ve cualquiera; un vendedor logueado, solo el suyo
router.get("/:id", protectSellerOrAdmin, getSellerById);

// Crear
router.post("/", protect, isAdmin, createSeller);

// Modificar
router.put("/:id", protect, isAdmin, updateSeller);

// Eliminar
router.delete("/:id", protect, isAdmin, deleteSeller);


module.exports = router;
