const rateLimit = require("express-rate-limit");

// Login/registro son el blanco típico de fuerza bruta y credential
// stuffing. 10 intentos cada 15 min por IP es generoso para alguien que se
// equivoca de contraseña, pero frena un script.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiados intentos. Esperá unos minutos e intentá de nuevo." },
});

// Red de contención general para el resto de la API — permisivo a
// propósito para no afectar el uso normal del panel, solo corta abuso
// evidente (scraping, scripts descontrolados).
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiadas solicitudes. Esperá un momento e intentá de nuevo." },
});

module.exports = { authLimiter, apiLimiter };
