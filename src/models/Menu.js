const mongoose = require("mongoose");

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
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Menu", MenuSchema);
