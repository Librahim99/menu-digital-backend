const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { hasMinPlan } = require("../config/plans");

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
 * Middleware factory que restringe una ruta a usuarios con determinado
 * plan (o superior, según PLAN_ORDER en config/plans.js). Siempre se usa
 * después de protect, ya que necesita req.user.subscription.
 *
 * Uso: router.post("/ruta-pro", protect, requirePlan("monthly"), controller)
 */
const requirePlan = (minPlan) => (req, res, next) => {
  if (!hasMinPlan(req.user?.subscription, minPlan)) {
    return res.status(403).json({ message: "Esta función requiere un plan pago." });
  }
  next();
};

module.exports = { protect, isAdmin, requirePlan };
