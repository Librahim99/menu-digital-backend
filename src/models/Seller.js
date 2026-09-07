const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const SellerSchema = new mongoose.Schema(
    {
      name: {
      type: String,
      required: [true, "El nombre es obligatorio"],
      unique: true,
      trim: true,
    },password: {
      type: String,
      required: [true, "La contraseña es obligatoria"],
      minlength: 8,
      select: false
    },admin: {
      type: Boolean,
      default: false,
    },
     code: {
      type: String,
      required: [true, "El código es obligatorio"],
      unique: true,
      trim: true,
    },
    mail: {
        type: String,
        required: [true, "contactInfo.mail es obligatorio"],
        validate: {
          validator: (v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
          message: "contactInfo.mail debe ser un email válido",
        },
      },
    number: { 
        type: Number, 
        default: null 
      },
    dni: {
      type: String,
      required: [true, "El DNI es obligatorio"],
      unique: true,
      trim: true,
    },
    profilePicture : {
      type: String,
      default: null,
    },
    active: {
      type: Boolean,
      default: true,
    },
    startDate: {
      type: Date,
      default: null,
    },
  }, {
    timestamps: true, // Agrega createdAt y updatedAt automáticamente
  }
)


// ──────────────────────────────────────────────
// HOOKS (Middleware de Mongoose)
// ──────────────────────────────────────────────

/**
 * Antes de guardar, hashea la contraseña si fue modificada.
 * Evita re-hashear si el campo password no cambió.
 */
SellerSchema.pre("save", async function (next) {
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
SellerSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};


module.exports = mongoose.model("Seller", SellerSchema);