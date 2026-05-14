const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const { uploadUser } = require("../config/cloudinary");
const {
  newUser,
  loginUser,
  getAuthUser,
  fetchUserWithMenu,
  fetchUser,
  editUser,
  uploadImage,
  useTemplate,
  setActive,
} = require("../controllers/userController");

// ──────────────────────────────────────────────
// Rutas públicas
// ──────────────────────────────────────────────
router.post("/register", newUser);
router.post("/login", loginUser);
// Acá va la ruta para cuando se olvidan la contraseña

// ──────────────────────────────────────────────
// Rutas privadas (requieren JWT)
// IMPORTANTE: /me debe ir ANTES de /:slug para que Express no lo interprete como slug
// ──────────────────────────────────────────────
router.get("/me", protect, getAuthUser);    // Datos del user autenticado (panel admin)
router.put("/me", protect, editUser);
router.post("/upload-image", protect, uploadUser.single("image"), uploadImage);
router.patch("/template", protect, useTemplate);
router.patch("/active", protect, setActive);
// Acá va la ruta para cambiar la contraseña


// Ruta pública por slug — va AL FINAL para no interceptar rutas con nombre fijo
// Ej: GET /api/users/cafe-roma  →  devuelve el user con businessName "cafe roma"
router.get("/:slug/menu", fetchUserWithMenu);
router.get("/:slug", fetchUser);

module.exports = router;