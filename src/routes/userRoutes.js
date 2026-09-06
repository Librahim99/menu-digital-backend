const express = require("express");
const router = express.Router();
const { protect, requireFeature } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimiters");
const { uploadUser } = require("../config/cloudinary");
const {
  newUser,
  loginUser,
  verifyEmail,
  resendVerificationCode,
  getAuthUser,
  fetchUserWithMenu,
  downloadMenuPdf,
  fetchOwnMenu,
  fetchStats,
  trackItemViewEndpoint,
  fetchItemStats,
  fetchUser,
  editUser,
  requestEmailChange,
  confirmEmailChange,
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
// authLimiter: mismo criterio que /register — el claim ya corta a los 5
// intentos por código (ver claimPendingServiceAction), esto además limita
// cuántos códigos puede pedir/probar una cuenta por IP.
router.post("/me/verify-email", protect, authLimiter, verifyEmail);
router.post("/me/verify-email/resend", protect, authLimiter, resendVerificationCode);
router.get("/me/menu", protect, fetchOwnMenu); // Menú completo del user autenticado, sin filtrar ocultos
router.get("/me/stats", protect, requireFeature("estadisticas"), fetchStats); // Estadísticas de visitas (plan pro+)
router.get("/me/item-stats", protect, requireFeature("estadisticas"), fetchItemStats); // Top de productos más vistos (plan pro+)
router.put("/me", protect, editUser);
// authLimiter: mismo criterio que verify-email — el claim ya corta a los 5
// intentos por código, esto además limita cuántos pedidos/códigos puede
// probar una cuenta por IP.
router.post("/me/email-change", protect, authLimiter, requestEmailChange);
router.post("/me/email-change/confirm", protect, authLimiter, confirmEmailChange);
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
router.post("/:slug/menu/items/:itemID/view", trackItemViewEndpoint); // Tracking de "vista" de un producto puntual
router.get("/:slug/menu/pdf", downloadMenuPdf); // Descarga del menú en PDF
router.get("/:slug/menu", fetchUserWithMenu);
router.get("/:slug", fetchUser);

module.exports = router;