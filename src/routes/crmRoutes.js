const express = require("express");
const router = express.Router();
const { isAdmin, protectSellerOrAdminAny } = require("../middleware/auth");
const {
  listClients,
  getClient,
  updateProfile,
  addNote,
  deleteNote,
  getOverdueCount,
  exportClients,
} = require("../controllers/crmController");

// CRM: lo maneja tanto un admin (ve todo) como un vendedor (ve y edita solo
// sus propios clientes atribuidos — el scoping vive en cada controller,
// filtrando la query por req.seller._id en vez de post-filtrar el resultado,
// para que un olvido de scoping en un path nuevo falle cerrado, no abierto).
router.use(protectSellerOrAdminAny);

// Rutas de nombre fijo van ANTES de /clients/:userID para no chocar con el param.
router.get("/overdue-count", getOverdueCount);
// Exportar a xlsx queda exclusivo admin (reusa isAdmin: un token de vendedor
// nunca setea req.user, así que ya bloquea solo con esto).
router.get("/export", isAdmin, exportClients);

router.get("/clients", listClients);
router.get("/clients/:userID", getClient);
router.patch("/clients/:userID", updateProfile);
router.post("/clients/:userID/notes", addNote);
router.delete("/clients/:userID/notes/:noteID", deleteNote);

module.exports = router;
