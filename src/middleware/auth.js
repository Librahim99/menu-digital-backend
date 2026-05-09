const jwt = require("jsonwebtoken");
const User = require("../models/User");

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
    // Verifica y decodifica el token con el secret
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

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

module.exports = { protect };
