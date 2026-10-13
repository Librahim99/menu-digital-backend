const { handleError } = require("../utils/handleError");
const User = require("../models/User");
const Menu = require("../models/Menu");
const Item = require("../models/Item");
const { getSubscriptionState } = require("../config/plans");
const { logCrmEvent } = require("../utils/crmEvents");
const { EXCLUDE_TEST_USERS } = require("../utils/testUsers");

const toAdminUserDTO = (user) => {
  const plain = typeof user.toObject === "function" ? user.toObject() : { ...user };
  const state = getSubscriptionState(plain.subscription, plain.subscriptionExpiresAt);
  return {
    ...plain,
    // Conservamos el plan comprado en el campo histórico y añadimos el
    // efectivo para que los consumidores puedan filtrar permisos sin perder
    // contexto de la cuenta.
    subscription: plain.subscription,
    effectiveSubscription: state.effectivePlan,
    subscriptionStatus: state.subscriptionStatus,
    previousSubscription: state.previousSubscription,
    downgradeReason: state.downgradeReason,
    downgradedAt: state.downgradedAt,
  };
};


// ──────────────────────────────────────────────
// @desc    Obtener lista de todos los usuarios (solo para admin)
// @route   GET /api/admin/allUsers
// @access  Private (admin)
// ──────────────────────────────────────────────

const getAllUsers = async (req, res) => {
  try {
    if (!req.user.admin) {
      return res.status(403).json({ message: "Acceso denegado" });
    }
    const users = await User.find().select("-password");
    res.json(users.map(toAdminUserDTO));
  } catch (error) {
    handleError(res, error);
  }
};


// ──────────────────────────────────────────────
// @desc    Obtener un usuario por el ID (solo para admin)
// @route   GET /api/admin/:userID
// @access  Private (admin)
// ──────────────────────────────────────────────

const getUser = async (req, res) => {
    try {
        if (!req.user.admin) {
        return res.status(403).json({ message: "Acceso denegado" });
        }
    const { userID } = req.params 
    const user = await User.findById(userID).select("-password");
    res.json(user ? toAdminUserDTO(user) : user);
  } catch (error) {
    handleError(res, error);
  }
}


// ──────────────────────────────────────────────
// @desc    Activar o desactivar la cuenta de cualquier cliente
// @route   PATCH /api/admin/users/:userID/active
// @access  Admin
// ──────────────────────────────────────────────
const setActiveUser = async (req, res) => {
  try {
    const { active } = req.body;
 
    if (typeof active !== "boolean") {
      return res.status(400).json({ message: "active debe ser un booleano" });
    }
 
    // Evita que el admin se desactive a sí mismo por accidente
    if (req.params.userID === req.user._id.toString()) {
      return res.status(400).json({ message: "No podés modificar tu propio estado desde acá" });
    }
 
    const user = await User.findById(req.params.userID);
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });
 
    // No se puede modificar a otro admin
    if (user.admin) {
      return res.status(403).json({ message: "No podés modificar la cuenta de otro administrador" });
    }
 
    user.active = active;
    await user.save();

    await logCrmEvent(user._id, active ? "Cuenta activada por el CEO" : "Cuenta desactivada por el CEO");

    res.json({
      message: `Cuenta ${active ? "activada" : "desactivada"} correctamente`,
      user: {
        _id: user._id,
        username: user.username,
        slug: user.slug,
        active: user.active,
        businessName: user.contactInfo?.businessName || "",
      },
    });
  } catch (err) {
    handleError(res, err);
  }
};
 
// ──────────────────────────────────────────────
// @desc    Estadísticas globales de la plataforma
// @route   GET /api/admin/stats
// @access  Admin
// ──────────────────────────────────────────────
const getStats = async (req, res) => {
  try {
    // Los usuarios de prueba de los vendedores no son clientes: quedan afuera
    // de los conteos de cuentas y también de los de su contenido (Menu cuelga
    // del user e Item del menú, así que se excluyen por esos ids).
    const clients = { admin: false, ...EXCLUDE_TEST_USERS };
    const testUserIDs = await User.find({ testUser: true }).distinct("_id");
    const testMenuIDs = testUserIDs.length
      ? await Menu.find({ userID: { $in: testUserIDs } }).distinct("_id")
      : [];
    const menus = testUserIDs.length ? { userID: { $nin: testUserIDs } } : {};
    const items = testMenuIDs.length ? { menuID: { $nin: testMenuIDs } } : {};

    // Ejecutamos todas las queries en paralelo para mayor performance
    const [
      totalUsers,
      activeUsers,
      inactiveUsers,
      usersWithMenu,
      totalMenus,
      totalSections,
      totalCategories,
      totalItems,
      availableItems,
      hiddenItems,
      recentUsers,
    ] = await Promise.all([
      User.countDocuments(clients),
      User.countDocuments({ ...clients, active: true }),
      User.countDocuments({ ...clients, active: false }),
      User.countDocuments({ ...clients, menu: true }),
      Menu.countDocuments(menus),
      Menu.countDocuments({ ...menus, section: true }),
      Menu.countDocuments({ ...menus, section: false }),
      Item.countDocuments(items),
      Item.countDocuments({ ...items, available: true, hidden: false }),
      Item.countDocuments({ ...items, hidden: true }),
      // Los 5 usuarios más recientes (sin admins ni usuarios de prueba)
      User.find(clients)
        .sort({ createdAt: -1 })
        .limit(5)
        .select("username slug active menu createdAt"),
    ]);
 
    res.json({
      usuarios: {
        total: totalUsers,
        activos: activeUsers,
        inactivos: inactiveUsers,
        conMenuPublicado: usersWithMenu,
        sinMenuPublicado: totalUsers - usersWithMenu,
      },
      menus: {
        total: totalMenus,
        secciones: totalSections,
        categorias: totalCategories,
      },
      items: {
        total: totalItems,
        disponibles: availableItems,
        ocultos: hiddenItems,
      },
      recientes: recentUsers,
    });
  } catch (err) {
    handleError(res, err);
  }
};


module.exports = {
    getAllUsers,
    getUser,
    setActiveUser,
    getStats
}
