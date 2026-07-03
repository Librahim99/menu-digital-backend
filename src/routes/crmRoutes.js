const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middleware/auth");
const {
  listClients,
  getClient,
  updateProfile,
  addNote,
  deleteNote,
} = require("../controllers/crmController");

// CRM interno del panel del CEO. Todas las rutas requieren token + admin.
router.use(protect, isAdmin);

router.get("/clients", listClients);
router.get("/clients/:userID", getClient);
router.patch("/clients/:userID", updateProfile);
router.post("/clients/:userID/notes", addNote);
router.delete("/clients/:userID/notes/:noteID", deleteNote);

module.exports = router;
