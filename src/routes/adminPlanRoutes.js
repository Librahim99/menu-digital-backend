const router = require("express").Router();
const { protect, isAdmin } = require("../middleware/auth");
const { listPlans, updatePlan } = require("../controllers/planController");

router.use(protect, isAdmin);
router.get("/", listPlans);
router.patch("/:name", updatePlan);

module.exports = router;
