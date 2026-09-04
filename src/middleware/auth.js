const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { getSubscriptionState } = require("../config/plans");
const { getRequestPlan } = require("../services/planCatalog");
const { handleError } = require("../utils/handleError");

/**
 * Middleware que protege rutas privadas.
 * Verifica que el request tenga un JWT válido en el header Authorization.
 * Si es válido, adjunta el user al objeto req para uso en controllers.
 *
 * Uso: router.get("/ruta-protegida", protect, controller)
 */
const protect = async (req, res, next) => {
  let token;

  // El token debe venir en el header: Authorization: Bearer <token>
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return res.status(401).json({ message: "No autorizado, token requerido" });
  }

  try {
    // Verifica y decodifica el token con el secret. Se fija el algoritmo
    // explícitamente (en vez de dejar que jwt.verify lo infiera del header
    // del token) como defensa en profundidad contra ataques de confusión
    // de algoritmo — esos tokens siempre se firman con HS256 (ver
    // generateToken en userController.js), así que no hay motivo para
    // aceptar ningún otro.
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });

    // Adjunta el user al request (sin la password)
    req.user = await User.findById(decoded.id).select("-password");

    if (!req.user) {
      return res.status(401).json({ message: "Usuario no encontrado" });
    }

    if (!req.user.active && !req.user.admin) {
      return res.status(403).json({ message: "Cuenta desactivada" });
    }

    // El resto de los middlewares/controllers recibe siempre el plan vigente.
    // No modificamos la base acá: preservamos el plan comprado como historial.
    const subscriptionState = getSubscriptionState(
      req.user.subscription,
      req.user.subscriptionExpiresAt
    );
    req.user.subscription = subscriptionState.effectivePlan;
    req.user.subscriptionStatus = subscriptionState.subscriptionStatus;

    next();
  } catch (error) {
    return res.status(401).json({ message: "Token inválido o expirado" });
  }
};


/**
 * Middleware que verifica que el user autenticado sea admin.
 * Siempre se usa después de protect.
 *
 * Uso: router.patch("/ruta-admin", protect, isAdmin, controller)
 */
const isAdmin = (req, res, next) => {
  if (!req.user?.admin) {
    return res.status(403).json({ message: "Acceso restringido a administradores" });
  }
  next();
};

/**
 * Restringe una operación por la configuración vigente guardada en MongoDB.
 * Siempre se usa después de protect. No confía en permisos enviados por el cliente.
 *
 * Uso: router.post("/ruta-paga", protect, requireFeature("menu_pdf"), controller)
 */
const requireFeature = (feature) => async (req, res, next) => {
  try {
    const plan = await getRequestPlan(req);
    if (plan.features[feature] !== true) {
      return res.status(403).json({ code: "FEATURE_NOT_INCLUDED", feature, message: "Tu plan no incluye esta función." });
    }
    next();
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports = { protect, isAdmin, requireFeature };
