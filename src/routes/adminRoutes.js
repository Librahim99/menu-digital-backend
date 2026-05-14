const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middleware/auth");
const { getAllUsers, getUser, setActiveUser, getStats } = require("../controllers/adminController");

// Todas las rutas admin requieren token válido + flag admin:true
router.get("/allUsers", protect, getAllUsers);    // Lista de todos los usuarios
router.get("/stats", protect, isAdmin, getStats); // Métricas generales de la base de datos
router.get("/:userID", protect, getUser); // Obtener un usuario por ID
router.patch("/users/:userID/active", protect, isAdmin, setActiveUser); // Activar o desactivar un usuario


module.exports = router;

