const express = require("express");
const router = express.Router();
const multer = require("multer");
const { protect, requirePlan } = require("../middleware/auth");
const { getTemplate, previewMassive, confirmMassive } = require("../controllers/massiveController");

// Multer en memoria — el Excel no se guarda en disco ni en Cloudinary,
// se procesa directamente desde el buffer y se descarta. Con memoria hay
// que ser más estricto con el tamaño: un archivo enorme se carga entero en
// RAM antes de procesarse. 5MB es de sobra para una planilla de productos.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// La carga masiva por Excel es una función paga ("carga_masiva_excel",
// desbloqueada desde el plan basic) — se gatean las 3 rutas.
const requireBasic = requirePlan("basic");

// GET  /api/massive/template  → descarga el Excel con los datos actuales
router.get("/template", protect, requireBasic, getTemplate);

// POST /api/massive/preview   → procesa el Excel y devuelve el resumen (sin guardar)
router.post("/preview", protect, requireBasic, upload.single("archivo"), previewMassive);

// POST /api/massive/confirm   → aplica los cambios fila por fila
router.post("/confirm", protect, requireBasic, upload.single("archivo"), confirmMassive);

module.exports = router;
