const { getPool } = require("../config/postgres");
const { OrdersError, sendError } = require("./errors");
const { getOrCreateSettings } = require("./services/settingsService");
const { authenticateSession } = require("./services/waiterService");
const { findOwnerById, isProOwner } = require("./services/menuCatalog");

// Sin DATABASE_URL (o sin Neon) el resto de la API sigue igual: solo estas
// rutas responden 503.
const requireOrdersDb = (req, res, next) => {
  if (!getPool()) {
    return res.status(503).json({ message: "La gestión de pedidos no está disponible en este momento." });
  }
  next();
};

// Después de protect: la gestión de pedidos es exclusiva del plan PRO
// vigente (protect ya dejó en req.user.subscription el plan efectivo).
const requireProPlan = (req, res, next) => {
  if (req.user?.subscription !== "pro") {
    return res.status(403).json({
      code: "FEATURE_NOT_INCLUDED",
      feature: "gestion_pedidos",
      message: "La gestión de pedidos está disponible en el plan Pro.",
    });
  }
  next();
};

// Configuración del local (se crea la primera vez).
const loadSettings = async (req, res, next) => {
  try {
    req.orderSettings = await getOrCreateSettings(String(req.user._id));
    next();
  } catch (error) {
    sendError(res, error);
  }
};

// Tomador de pedidos: el dispositivo del operador se identifica con
// "Authorization: Waiter <token>" (el token lo dio el QR de acceso).
const protectWaiter = async (req, res, next) => {
  try {
    const [scheme, token] = (req.headers.authorization ?? "").split(" ");
    if (scheme !== "Waiter" || !token) throw new OrdersError(401, "Escaneá tu QR de acceso para tomar pedidos.");

    const session = await authenticateSession(token);
    if (!session) throw new OrdersError(401, "Tu acceso ya no es válido. Escaneá un QR nuevo.", "WAITER_SESSION_INVALID");

    const owner = await findOwnerById(session.ownerId);
    if (!owner || !owner.active || !isProOwner(owner)) {
      throw new OrdersError(403, "El local no tiene la gestión de pedidos habilitada.");
    }

    req.waiterSession = session;
    req.owner = owner;
    req.orderSettings = await getOrCreateSettings(session.ownerId);
    next();
  } catch (error) {
    sendError(res, error);
  }
};

module.exports = { requireOrdersDb, requireProPlan, loadSettings, protectWaiter };
