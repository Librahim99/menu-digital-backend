const Seller = require("../models/Seller");
const { handleError } = require("../utils/handleError");
const { getOverviewForSellers, getRanking } = require("../services/sellerPanelService");

const RANKING_PERIODS = ["current", "previous", "historic"];

// ──────────────────────────────────────────────
// @desc    Perfil propio del vendedor autenticado.
// @route   GET /api/sellers/me
// @access  Seller
// ──────────────────────────────────────────────
const getMyProfile = async (req, res) => {
  try {
    const seller = req.seller;
    res.json({
      _id: seller._id,
      name: seller.name,
      mail: seller.mail,
      number: seller.number,
      code: seller.code,
      active: seller.active,
      startDate: seller.startDate,
      profilePicture: seller.profilePicture,
      admin: seller.admin,
      createdAt: seller.createdAt,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Cambiar la propia contraseña (pide la actual).
// @route   PATCH /api/sellers/me/password
// @access  Seller
// ──────────────────────────────────────────────
const changeMyPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "La contraseña actual y la nueva son obligatorias" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ message: "La nueva contraseña debe tener al menos 8 caracteres" });
    }

    // req.seller viene de protectSeller sin el campo password (select:false
    // por defecto en el schema) — hay que volver a buscarlo con +password.
    const seller = await Seller.findById(req.seller._id).select("+password");
    const matches = await seller.matchPassword(currentPassword);
    if (!matches) {
      return res.status(401).json({ message: "La contraseña actual no es correcta" });
    }

    seller.password = newPassword;
    await seller.save(); // el hook pre("save") la rehashea

    res.json({ message: "Contraseña actualizada correctamente" });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Subir/reemplazar la foto de perfil propia.
// @route   POST /api/sellers/me/photo
// @access  Seller
// ──────────────────────────────────────────────
const uploadMyPhoto = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No se recibió ningún archivo" });

    const imageUrl = req.file.path; // URL de Cloudinary, seteada por CloudinaryStorage
    const seller = await Seller.findByIdAndUpdate(
      req.seller._id,
      { profilePicture: imageUrl },
      { new: true },
    );

    res.json({ profilePicture: seller.profilePicture });
  } catch (error) {
    handleError(res, error);
  }
};

// Facturación real es plata que un vendedor nunca debe ver de otro (ni de sí
// mismo, según lo pedido: solo el admin ve facturación). Se saca del payload
// acá, del lado del servidor, en vez de confiar en que el frontend no la
// renderice.
const stripRevenue = (entry) => {
  const withoutRevenue = (bucket) => {
    const { revenue, ...rest } = bucket;
    return rest;
  };
  return {
    ...entry,
    currentCycle: {
      ...entry.currentCycle,
      basic: withoutRevenue(entry.currentCycle.basic),
      pro: withoutRevenue(entry.currentCycle.pro),
      total: withoutRevenue(entry.currentCycle.total),
    },
  };
};

// ──────────────────────────────────────────────
// @desc    Panel general: clientes vendidos totales + del ciclo actual +
//          comisión del ciclo actual. Un vendedor ve solo lo propio; un admin
//          ve a todos (o uno puntual con ?sellerID=) y además ve facturación.
// @route   GET /api/sellers/overview
// @access  Seller (self) | Admin (todos o ?sellerID=)
// ──────────────────────────────────────────────
const getOverview = async (req, res) => {
  try {
    let sellers;
    let scope;

    if (req.seller) {
      sellers = [req.seller];
      scope = "self";
    } else {
      const { sellerID } = req.query;
      if (sellerID) {
        // getOverviewForSellers/cycleAnchor solo leen estos campos del seller.
        const seller = await Seller.findById(sellerID).select("name code active startDate createdAt");
        if (!seller) return res.status(404).json({ message: "Vendedor no encontrado" });
        sellers = [seller];
        scope = "single";
      } else {
        sellers = await Seller.find().select("name code active startDate createdAt");
        scope = "all";
      }
    }

    const overview = await getOverviewForSellers(sellers);
    const isAdmin = Boolean(req.user);
    const payload = isAdmin ? overview : overview.map(stripRevenue);

    res.json({ scope, sellers: payload });
  } catch (error) {
    handleError(res, error);
  }
};

// ──────────────────────────────────────────────
// @desc    Ranking de vendedores por comisión/puntos, separado por plan, para
//          un período (ciclo actual, anterior, o histórico acumulado).
// @route   GET /api/sellers/ranking?period=current|previous|historic
// @access  Admin
// ──────────────────────────────────────────────
const getSellersRanking = async (req, res) => {
  try {
    const period = RANKING_PERIODS.includes(req.query.period) ? req.query.period : "current";
    // getRanking/cycleAnchor solo leen estos campos del seller.
    const sellers = await Seller.find().select("name code active startDate createdAt");
    const ranking = await getRanking(sellers, { period });

    res.json({ period, sellers: ranking });
  } catch (error) {
    handleError(res, error);
  }
};

module.exports = {
  getMyProfile,
  changeMyPassword,
  uploadMyPhoto,
  getOverview,
  getSellersRanking,
};
