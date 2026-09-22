const mongoose = require("mongoose");
const { isValidImageUrl } = require("../utils/imageUrl");

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
    },

    // Rango de fechas en el que aplica la oferta. Los dos extremos son
    // opcionales e independientes (solo desde, solo hasta, ambos o ninguno);
    // sin rango ni offerSchedule el offerPrice es manual/permanente. La API
    // pública resuelve la vigencia (ver utils/offers.js).
    offerRange: {
      from: { type: Date, default: null }, // Inicio de la oferta
      to:   { type: Date, default: null }, // Fin de la oferta
    },

    // Días y horarios de la semana en los que rige la oferta, con el mismo
    // shape que availabilitySchedule. Se combina con offerRange: el rango
    // acota las fechas y esto, dentro de esas fechas, los días y las horas.
    offerSchedule: {
      enabled: { type: Boolean, default: false },
      mon: { type: [TimeRangeSchema], default: [] },
      tue: { type: [TimeRangeSchema], default: [] },
      wed: { type: [TimeRangeSchema], default: [] },
      thu: { type: [TimeRangeSchema], default: [] },
      fri: { type: [TimeRangeSchema], default: [] },
      sat: { type: [TimeRangeSchema], default: [] },
      sun: { type: [TimeRangeSchema], default: [] },
    },

    /**
     * Variantes o adicionales del item.
     * Ej: { "Tamaño chico": 800, "Tamaño grande": 1200 }
     */
    options: {
      type: Map,
      of: Number,
      default: {},
      validate: {
        // Segunda barrera — itemController ya rechaza esto antes de llegar
        // acá (ver hasNegativeOptionPrice), pero a diferencia de price no
        // había ningún chequeo a nivel modelo.
        validator: (map) => !map || [...map.values()].every((v) => v == null || v >= 0),
        message: "El precio de una variante no puede ser negativo",
      },
    },

    image: {
      type: String,
      default: "", // URL de imagen del producto
      validate: {
        validator: isValidImageUrl,
        message: "La imagen debe ser una URL de Cloudinary válida",
      },
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
      // Opcional: fuera de estas fechas la programación no rige y vuelve a
      // mandar el interruptor manual `available`. Los extremos son
      // independientes entre sí.
      dateRange: {
        from: { type: Date, default: null },
        to:   { type: Date, default: null },
      },
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

// Índice para las lecturas por categoría (Item.find / countDocuments con
// { menuID: { $in }, hidden }): la carta pública, el editor, /me, el PDF y el
// sitemap. Hoy esas queries son un COLLSCAN que cuesta ~1 ms porque la
// colección es chica; el índice es para que el costo no crezca linealmente con
// la cantidad de productos de todos los locales. Lo construye el autoIndex de
// Mongoose al arrancar la app (config/db.js no lo desactiva); ningún script lo
// crea. Las queries solo por menuID lo usan por prefijo.
ItemSchema.index({ menuID: 1, hidden: 1 });

module.exports = mongoose.model("Item", ItemSchema);
