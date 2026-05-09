const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const multer = require("multer");

// ──────────────────────────────────────────────
// Configura Cloudinary con las credenciales del .env
// ──────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ──────────────────────────────────────────────
// Storage para imágenes de Usuario
// Se guardan en la carpeta "menu-digital/users" de tu Cloudinary
// ──────────────────────────────────────────────
const userStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "menu-digital/users",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [{ width: 1200, crop: "limit" }], // Limita tamaño máximo
  },
});

// ──────────────────────────────────────────────
// Storage para imágenes de Menú (categorías)
// ──────────────────────────────────────────────
const menuStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "menu-digital/menus",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [{ width: 800, crop: "limit" }],
  },
});

// ──────────────────────────────────────────────
// Storage para imágenes de Items (productos)
// ──────────────────────────────────────────────
const itemStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "menu-digital/items",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [{ width: 800, crop: "limit" }],
  },
});

// Exportamos cloudinary por si necesitamos usarlo directamente (ej: eliminar imágenes)
module.exports = {
  cloudinary,
  uploadUser: multer({ storage: userStorage }),
  uploadMenu: multer({ storage: menuStorage }),
  uploadItem: multer({ storage: itemStorage }),
};