const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middleware/auth");
const { listPayments } = require("../controllers/adminPaymentController");

router.use(protect, isAdmin);
router.get("/", listPayments);

module.exports = router;
