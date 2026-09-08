const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

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

// Subida de imágenes del Gestor: cada request sube directo a Cloudinary
// (costo real, no solo lectura de Mongo), y el tope de item_limit por plan
// (ver checkImageQuota en itemController.js) no alcanza sola porque Pro no
// tiene item_limit (null = ilimitado). Clave por usuario, no por IP —
// varios usuarios detrás del mismo NAT/oficina no deben compartir el cupo,
// y a diferencia de auth/apiLimiter acá siempre hay un req.user (corre
// después de protect).
const imageUploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  // ipKeyGenerator normaliza IPv6 (agrupa por subred /64) para el caso
  // borde sin req.user — express-rate-limit v8 lo exige, si no un mismo
  // usuario con IPv6 podría esquivar el límite variando la dirección.
  keyGenerator: (req) => req.user?._id?.toString() || ipKeyGenerator(req.ip),
  message: { message: "Subiste demasiadas imágenes en poco tiempo. Esperá unos minutos e intentá de nuevo." },
});

module.exports = { authLimiter, apiLimiter, imageUploadLimiter };
