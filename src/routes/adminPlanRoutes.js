const router = require("express").Router();
const { protect, isAdmin } = require("../middleware/auth");
const { listPlans, updatePlan, getPlanUsage } = require("../controllers/planController");

router.use(protect, isAdmin);
router.get("/", listPlans);
router.get("/usage", getPlanUsage);
router.patch("/:name", updatePlan);

module.exports = router;
