const mongoose = require("mongoose");

/**
 * Item representa un producto del menú (ej: "Pizza Napolitana").
 * Pertenece a un Menu específico mediante menuID.
 */
const ItemSchema = new mongoose.Schema(
  {
    menuID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Menu",
      required: true,
    },

    code: {
      type: String,
      trim: true,
      default: "",
    },

    title: {
      type: String,
      required: [true, "El título del item es obligatorio"],
      trim: true,
    },

    description: {
      type: String,
      default: "",
    },

    price: {
      type: Number,
      default: null, // null = sin precio (ej: item de sección)
    },

    offerPrice: {
      type: Number,
      default: null, // Precio en oferta, si aplica
    },

    offerDate: {
      type: Date,
      default: null, // Fecha hasta la que aplica la oferta
    },

    /**
     * Variantes o adicionales del item.
     * Ej: { "Tamaño chico": 800, "Tamaño grande": 1200 }
     */
    options: {
      type: Map,
      of: Number,
      default: {},
    },

    image: {
      type: String,
      default: "", // URL de imagen del producto
    },

    available: {
      type: Boolean,
      default: true, // Si está disponible para pedir
    },

    isExtra: {
      type: Boolean,
      default: false, // Si es un adicional/extra (ej: salsa, bebida)
    },

    recommended: {
      type: Boolean,
      default: false, // Para destacarlo en la vista del cliente
    },

    hidden: {
      type: Boolean,
      default: false, // Oculto del menú público sin eliminarlo
    },

    /**
     * Información adicional libre.
     * Ej: { "alérgenos": "gluten", "calorias": 450 }
     */
    apt: {
      type: Object,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Item", ItemSchema);
