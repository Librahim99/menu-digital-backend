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

// Verificación de email post-registro. Antes compartían authLimiter con
// login/registro (10 cada 15 min por IP): alguien que se registraba, entraba
// y se equivocaba un par de veces con el código se quedaba sin cupo. Clave
// por usuario porque siempre corren después de protect — mismo criterio que
// imageUploadLimiter. El tope por código lo sigue poniendo
// claimPendingServiceAction (5 intentos).
const verifyEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || ipKeyGenerator(req.ip),
  message: { message: "Demasiados intentos. Esperá unos minutos e intentá de nuevo." },
});

// Cada pedido manda un mail real (reenvío o corrección del email): más
// estricto que probar un código.
const verificationMailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?._id?.toString() || ipKeyGenerator(req.ip),
  message: { message: "Pediste demasiados códigos. Esperá unos minutos e intentá de nuevo." },
});

module.exports = {
  authLimiter,
  apiLimiter,
  imageUploadLimiter,
  verifyEmailLimiter,
  verificationMailLimiter,
};
