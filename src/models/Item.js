const mongoose = require("mongoose");

const TimeRangeSchema = new mongoose.Schema(
  {
    from: { type: String, required: true },
    to: { type: String, required: true },
  },
  { _id: false }
);

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
          validate: {
            validator: (v) => v == null || v >= 0,
            message: "El precio no puede ser negativo",
        },
    },

    offerPrice: {
  type: Number,
  default: null, // Precio en oferta, si aplica
  min: [0, "El precio en oferta no puede ser negativo"],
  validate: {
    validator: function (v) {
      // Si no hay precio de oferta, está bien
      if (v == null) return true;
      // Debe ser menor que el precio normal
      return this.price != null && v < this.price;
    },
    message: "El precio de oferta debe ser menor al precio",
  },
},

    // Rango de fecha y hora en el que aplica la oferta. Sin rango, el
    // offerPrice es manual/permanente; la API pública resuelve la vigencia.
    offerRange: {
      from: { type: Date, default: null }, // Inicio de la oferta
      to:   { type: Date, default: null }, // Fin de la oferta
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

    // Ventanas semanales de disponibilidad del producto. `available` sigue
    // siendo el interruptor manual principal; este horario solo lo restringe.
    availabilitySchedule: {
      enabled: { type: Boolean, default: false },
      mon: { type: [TimeRangeSchema], default: [] },
      tue: { type: [TimeRangeSchema], default: [] },
      wed: { type: [TimeRangeSchema], default: [] },
      thu: { type: [TimeRangeSchema], default: [] },
      fri: { type: [TimeRangeSchema], default: [] },
      sat: { type: [TimeRangeSchema], default: [] },
      sun: { type: [TimeRangeSchema], default: [] },
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
