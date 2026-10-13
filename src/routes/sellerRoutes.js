const express = require("express");
const router = express.Router();
const { protect, isAdmin, protectSellerOrAdmin } = require("../middleware/auth");

const  {
  getSellers,
  getSellerById,
  createSeller,
  updateSeller,
  deleteSeller,
  resetSellerPassword,
  createSellerTestUser,
} = require("../controllers/sellerController.js");
// Obtener todos
router.get("/", protect, isAdmin, getSellers);

// Obtener por ID — admin ve cualquiera; un vendedor logueado, solo el suyo
router.get("/:id", protectSellerOrAdmin, getSellerById);

// Crear
router.post("/", protect, isAdmin, createSeller);

// Modificar
router.put("/:id", protect, isAdmin, updateSeller);

// Restablecer contraseña (admin, sin pedir la actual)
router.patch("/:id/password", protect, isAdmin, resetSellerPassword);

// Crear el usuario de prueba (cuenta de comercio Pro para las demos del vendedor)
router.post("/:id/test-user", protect, isAdmin, createSellerTestUser);

// Dar de baja (baja lógica: active:false)
router.delete("/:id", protect, isAdmin, deleteSeller);


module.exports = router;
