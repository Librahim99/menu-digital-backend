const express = require("express");
const router = express.Router();
const { protect, isAdmin, protectSeller, protectSellerOrAdminAny, denyInfluencer } = require("../middleware/auth");
const { uploadSeller } = require("../config/cloudinary");
const {
  getMyProfile,
  changeMyPassword,
  uploadMyPhoto,
  getOverview,
  getSellersRanking,
  getMyInfluencerOverview,
} = require("../controllers/sellerPanelController");

// Autoservicio del propio vendedor — no tiene sentido para un admin, que no
// es un documento Seller.
router.get("/me", protectSeller, getMyProfile);
router.patch("/me/password", protectSeller, changeMyPassword);
router.post("/me/photo", protectSeller, uploadSeller.single("image"), uploadMyPhoto);

// Panel general: un vendedor ve solo lo propio, un admin ve todos (o uno
// puntual con ?sellerID=) y además ve facturación.
router.get("/influencer/overview", protectSeller, getMyInfluencerOverview);
router.get("/overview", protectSellerOrAdminAny, denyInfluencer, getOverview);

// Ranking: exclusivo admin.
router.get("/ranking", protect, isAdmin, getSellersRanking);

module.exports = router;
