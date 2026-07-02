const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const UserSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, "El username es obligatorio"],
      unique: true,
      trim: true,
    },

    slug: {
      type: String,
      unique: true,
      sparse: true, // Permite null hasta que se complete el contactInfo
      trim: true,
    },

    password: {
      type: String,
      required: [true, "La contraseña es obligatoria"],
      // 8 es el piso que recomienda NIST 800-63B — la validación "de verdad"
      // (longitud + lista de contraseñas trivial-comunes) vive en
      // newUser (userController.js), esto es una red de contención por si
      // algún día se crea un User por otro camino.
      minlength: 8,
      select: false, // No se devuelve en queries por defecto (seguridad)
    },

    active: {
      type: Boolean,
      default: true,
    },

    admin: {
      type: Boolean,
      default: false,
    },

    menu: {
      type: Boolean,
      default: false, // Indica si el user tiene menú creado
    },

    subscription: {
      type: String,
      enum: ["none", "monthly", "semestral", "annual"],
      default: "none",
    },

    hasDelivery: {
      type: Boolean,
      default: false,
    },

    template: {
      type: Number,
      default: 1, // Template visual elegido para su landing/menú
    },

    acceptedTerms: {
  type: Boolean,
  default: false,
},

acceptedTermsAt: {
  type: Date,
},

acceptedTermsVersion: {
  type: String,
  default: null,
},

    // Info de contacto del local (mail, teléfono, ubicación, redes, etc.)
    contactInfo: {
      mail: { type: String, default: "" },
      number: { type: Number, default: null },
      location: { type: Object, default: {} }, // Ej: { lat, lng }
      address: { type: String, default: "" },
      social: { type: Object, default: {} }, // Ej: { instagram: "", facebook: "" }
      businessName: { type: String, default: "" }, // Nombre visible del local
    },

    // Imágenes del local (galería y foto de portada)
    media: {
      pictures: { type: [String], default: [] }, // Array de URLs
      backgroundPicture: { type: String, default: "" },
    },
  },
  {
    timestamps: true, // Agrega createdAt y updatedAt automáticamente
  }
);


// ──────────────────────────────────────────────
// HOOKS (Middleware de Mongoose)
// ──────────────────────────────────────────────

/**
 * Antes de guardar, hashea la contraseña si fue modificada.
 * Evita re-hashear si el campo password no cambió.
 */
UserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ──────────────────────────────────────────────
// MÉTODOS DE INSTANCIA
// ──────────────────────────────────────────────

/**
 * Compara la contraseña ingresada con el hash almacenado.
 * Se usa en el login.
 */
UserSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model("User", UserSchema);