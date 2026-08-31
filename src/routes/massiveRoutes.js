const express = require("express");
const router = express.Router();
const multer = require("multer");
const { protect, requireFeature } = require("../middleware/auth");
const { getTemplate, previewMassive, confirmMassive } = require("../controllers/massiveController");

// Multer en memoria — el Excel no se guarda en disco ni en Cloudinary,
// se procesa directamente desde el buffer y se descarta. Con memoria hay
// que ser más estricto con el tamaño: un archivo enorme se carga entero en
// RAM antes de procesarse. 5MB es de sobra para una planilla de productos.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// El catálogo decide qué planes permiten Excel; todas las rutas se validan.
const requireExcel = requireFeature("carga_masiva_excel");

// GET  /api/massive/template  → descarga el Excel con los datos actuales
router.get("/template", protect, requireFeature("menu_editor"), requireExcel, getTemplate);

// POST /api/massive/preview   → procesa el Excel y devuelve el resumen (sin guardar)
router.post("/preview", protect, requireFeature("menu_editor"), requireExcel, upload.single("archivo"), previewMassive);

// POST /api/massive/confirm   → aplica los cambios fila por fila
router.post("/confirm", protect, requireFeature("menu_editor"), requireExcel, upload.single("archivo"), confirmMassive);

module.exports = router;
