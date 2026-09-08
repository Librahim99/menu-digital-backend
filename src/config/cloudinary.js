// Ojo: siempre usar .v2. El require("cloudinary") a secas en 2.x
// sigue exponiendo una capa de compatibilidad vieja que en algunos
// casos cuelga upload_stream.
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("./cloudinaryStorage");
const multer = require("multer");
const crypto = require("crypto");

// ──────────────────────────────────────────────
// Configuración
// ──────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true, // fuerza https
});

// 8MB — suficiente para foto de celular, evita abuso de memoria/cuota
const IMAGE_SIZE_LIMIT = { fileSize: 8 * 1024 * 1024 };

// Filtro de mimetype (primera línea de defensa)
const imageFilter = (req, file, cb) => {
  const allowed = ["image/jpeg", "image/png", "image/webp"];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Solo se permiten imágenes JPG, PNG o WebP"), false);
  }
};

// ──────────────────────────────────────────────
// Storages
// ──────────────────────────────────────────────
const userStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "menu-digital/users",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [{ width: 1200, crop: "limit" }],
  },
});

const menuStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "menu-digital/menus",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [{ width: 800, crop: "limit" }],
  },
});

const itemStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "menu-digital/items",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [{ width: 800, crop: "limit" }],
  },
});

const sellerStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "menu-digital/sellers",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [{ width: 1200, crop: "limit" }],
  },
});

// Storage del Gestor de imágenes: mismo folder que itemStorage, pero con
// public_id propio (userID + número) para no depender del auto-generado de
// Cloudinary — así se puede reconocer de quién es cada imagen si algún día
// hace falta listarlas por prefijo. `params` como función async: necesita
// `req.user`, que ya está poblado acá porque `protect` corre antes que
// multer en toda la cadena de rutas (ver itemRoutes.js).
const itemLibraryStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req) => ({
    folder: "menu-digital/items",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [{ width: 800, crop: "limit" }],
    // crypto.randomInt (no Math.random): dos subidas casi simultáneas no
    // pueden generar el mismo public_id y pisarse una a la otra en Cloudinary.
    public_id: `${req.user._id}_${Date.now()}${crypto.randomInt(100000, 999999)}`,
  }),
});

// ──────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────
module.exports = {
  cloudinary,
  uploadUser: multer({
    storage: userStorage,
    limits: IMAGE_SIZE_LIMIT,
    fileFilter: imageFilter,
  }),
  uploadMenu: multer({
    storage: menuStorage,
    limits: IMAGE_SIZE_LIMIT,
    fileFilter: imageFilter,
  }),
  uploadItem: multer({
    storage: itemStorage,
    limits: IMAGE_SIZE_LIMIT,
    fileFilter: imageFilter,
  }),
  uploadSeller: multer({
    storage: sellerStorage,
    limits: IMAGE_SIZE_LIMIT,
    fileFilter: imageFilter,
  }),
  uploadItemLibrary: multer({
    storage: itemLibraryStorage,
    limits: IMAGE_SIZE_LIMIT,
    fileFilter: imageFilter,
  }),
};