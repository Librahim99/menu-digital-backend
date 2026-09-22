const mongoose = require("mongoose");
const { isValidImageUrl } = require("../utils/imageUrl");

/**
 * Cada documento Menu representa una categoría/sección del menú de un local.
 * Un User puede tener múltiples Menus (ej: "Bebidas", "Pizzas", "Postres").
 * Se relaciona con User por userID y con Items por menuID.
 */
const MenuSchema = new mongoose.Schema(
  {
    userID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // sectionID permite agrupar menus dentro de secciones más grandes si se necesita
    sectionID: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    code: {
      type: String,
      trim: true,
      default: "",
    },

    title: {
      type: String,
      required: [true, "El título del menú es obligatorio"],
      trim: true,
    },

    description: {
      type: String,
      default: "",
    },

    image: {
      type: String,
      default: "", // URL de imagen representativa de la categoría
      validate: {
        validator: isValidImageUrl,
        message: "La imagen debe ser una URL de Cloudinary válida",
      },
    },

    // true = este Menu es una sección contenedora, false = es una hoja con items
    section: {
      type: Boolean,
      default: false,
    },
    hidden: {
      type: Boolean,
      default: false,
    },

    // Posición de una sección entre las secciones del local, o de una
    // categoría dentro de su sección (o entre las que no tienen sección).
    // Sin default a propósito: lo anterior a este campo se ordena primero,
    // por orden de creación, como antes. Ver utils/menuOrder.js.
    order: {
      type: Number,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Índice para las lecturas por local (Menu.find({ userID, hidden })): la carta
// pública, el editor, /me, el PDF y el sitemap. Hoy esas queries son un
// COLLSCAN que cuesta ~1 ms porque la colección es chica; el índice es para
// que el costo no crezca linealmente con la cantidad de locales. Lo construye
// el autoIndex de Mongoose al arrancar la app (config/db.js no lo desactiva);
// ningún script lo crea. Las queries solo por userID lo usan por prefijo.
MenuSchema.index({ userID: 1, hidden: 1 });

module.exports = mongoose.model("Menu", MenuSchema);
