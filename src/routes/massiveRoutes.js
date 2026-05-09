const express = require("express");
const router = express.Router();
const multer = require("multer");
const { protect } = require("../middleware/auth");
const { getTemplate, previewMassive, confirmMassive } = require("../controllers/massiveController");

// Multer en memoria — el Excel no se guarda en disco ni en Cloudinary,
// se procesa directamente desde el buffer y se descarta
const upload = multer({ storage: multer.memoryStorage() });

// GET  /api/massive/template  → descarga el Excel con los datos actuales
router.get("/template", protect, getTemplate);

// POST /api/massive/preview   → procesa el Excel y devuelve el resumen (sin guardar)
router.post("/preview", protect, upload.single("archivo"), previewMassive);

// POST /api/massive/confirm   → aplica los cambios fila por fila
router.post("/confirm", protect, upload.single("archivo"), confirmMassive);

module.exports = router;