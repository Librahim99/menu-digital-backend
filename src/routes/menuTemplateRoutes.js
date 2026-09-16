const express = require("express");
const router = express.Router();
const { protect, requireFeature } = require("../middleware/auth");
const { getMenuTemplates, copyMenuTemplates } = require("../controllers/menuTemplateController");

router.get("/", protect, requireFeature("menu_templates"), getMenuTemplates);
router.post("/copy", protect, requireFeature("menu_templates"), copyMenuTemplates);

module.exports = router;
