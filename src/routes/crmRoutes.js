const express = require("express");
const router = express.Router();
const { isAdmin, protectSellerOrAdminAny, denyInfluencer } = require("../middleware/auth");
const {
  listClients,
  getClient,
  updateProfile,
  addNote,
  deleteNote,
  getOverdueCount,
  getCrmSummary,
  exportClients,
} = require("../controllers/crmController");

// Admin ve todo; vendedor ve sus clientes directos o asignados. El influencer
// solo accede a su panel y no puede consultar ni modificar datos internos de CRM.
router.use(protectSellerOrAdminAny, denyInfluencer);

// Rutas de nombre fijo van ANTES de /clients/:userID para no chocar con el param.
router.get("/overdue-count", getOverdueCount);
// Resumen ejecutivo del dashboard del CEO: exclusivo admin (mismo criterio
// que /export — un token de vendedor nunca setea req.user).
router.get("/summary", isAdmin, getCrmSummary);
// Exportar a xlsx queda exclusivo admin (reusa isAdmin: un token de vendedor
// nunca setea req.user, así que ya bloquea solo con esto).
router.get("/export", isAdmin, exportClients);

router.get("/clients", listClients);
router.get("/clients/:userID", getClient);
router.patch("/clients/:userID", updateProfile);
router.post("/clients/:userID/notes", addNote);
router.delete("/clients/:userID/notes/:noteID", deleteNote);

module.exports = router;
