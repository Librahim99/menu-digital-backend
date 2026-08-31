const router = require("express").Router();
const { listPlans } = require("../controllers/planController");

router.get("/", listPlans);

module.exports = router;
