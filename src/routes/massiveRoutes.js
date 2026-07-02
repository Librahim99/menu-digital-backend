const express = require("express");
const router = express.Router();
const multer = require("multer");
const { protect, requirePlan } = require("../middleware/auth");
const { getTemplate, previewMassive, confirmMassive } = require("../controllers/massiveController");

// Multer en memoria — el Excel no se guarda en disco ni en Cloudinary,
// se procesa directamente desde el buffer y se descarta
const upload = multer({ storage: multer.memoryStorage() });

// La carga masiva por Excel es una función paga ("carga_masiva_excel",
// desbloqueada desde el plan mensual) — se gatean las 3 rutas.
const requirePro = requirePlan("monthly");

// GET  /api/massive/template  → descarga el Excel con los datos actuales
router.get("/template", protect, requirePro, getTemplate);

// POST /api/massive/preview   → procesa el Excel y devuelve el resumen (sin guardar)
router.post("/preview", protect, requirePro, upload.single("archivo"), previewMassive);

// POST /api/massive/confirm   → aplica los cambios fila por fila
router.post("/confirm", protect, requirePro, upload.single("archivo"), confirmMassive);

module.exports = router;