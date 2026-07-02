const express = require("express");
const router = express.Router();
const { protect, requirePlan } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimiters");
const { uploadUser } = require("../config/cloudinary");
const {
  newUser,
  loginUser,
  getAuthUser,
  fetchUserWithMenu,
  fetchOwnMenu,
  fetchStats,
  fetchUser,
  editUser,
  uploadImage,
  uploadBackground,
  removeImage,
  deleteBackground,
  useTemplate,
  setActive,
} = require("../controllers/userController");

// ──────────────────────────────────────────────
// Rutas públicas
// ──────────────────────────────────────────────
router.post("/register", authLimiter, newUser);
router.post("/login", authLimiter, loginUser);
// Acá va la ruta para cuando se olvidan la contraseña

// ──────────────────────────────────────────────
// Rutas privadas (requieren JWT)
// IMPORTANTE: /me debe ir ANTES de /:slug para que Express no lo interprete como slug
// ──────────────────────────────────────────────
router.get("/me", protect, getAuthUser);    // Datos del user autenticado (panel admin)
router.get("/me/menu", protect, fetchOwnMenu); // Menú completo del user autenticado, sin filtrar ocultos
router.get("/me/stats", protect, requirePlan("semestral"), fetchStats); // Estadísticas de visitas (plan semestral+)
router.put("/me", protect, editUser);
router.post("/upload-image", protect, uploadUser.single("image"), uploadImage);
router.post("/upload-background", protect, uploadUser.single("image"), uploadBackground);
router.delete("/remove-image", protect, removeImage);
router.delete("/background", protect, deleteBackground);
router.patch("/template", protect, useTemplate);
router.patch("/active", protect, setActive);
// NOTA DE SEGURIDAD: existía acá un PATCH /subscription de autoservicio
// (protect, sin isAdmin) que dejaba que cualquier usuario logueado se
// asignara a sí mismo cualquier plan pago sin pagar nada — y encima el
// frontend nunca lo usaba (código muerto). Se eliminó. La única forma
// legítima de cambiar de plan es pagar de verdad: el webhook de
// MercadoPago (paymentController.mpWebhook) es quien actualiza
// User.subscription, después de verificar el pago contra la API de MP.
// Acá va la ruta para cambiar la contraseña


// Ruta pública por slug — va AL FINAL para no interceptar rutas con nombre fijo
// Ej: GET /api/users/cafe-roma  →  devuelve el user con businessName "cafe roma"
router.get("/:slug/menu", fetchUserWithMenu);
router.get("/:slug", fetchUser);

module.exports = router;