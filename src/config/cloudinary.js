// Ojo: siempre usar .v2. El require("cloudinary") a secas en 2.x
// sigue exponiendo una capa de compatibilidad vieja que en algunos
// casos cuelga upload_stream.
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("./cloudinaryStorage");
const multer = require("multer");

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
};