const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { isValidImageUrl } = require("../utils/imageUrl");

const UserSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, "El username es obligatorio"],
      unique: true,
      trim: true,
      // loginUser (userController.js) decide por el guion si una cuenta es
      // un vendedor (Seller.code, formato AAA-999) o un restaurante. La
      // validación "de verdad" vive en newUser y en crear-preferencia-registro
      // (src/utils/validators.js), esto es una red de contención por si algún
      // día se crea un User por otro camino.
      validate: {
        validator: (v) => typeof v !== "string" || !v.includes("-"),
        message: "El username no puede contener guiones",
      },
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

    // Verificación de email post-registro (código de 6 dígitos, ver
    // PendingServiceAction action:"verificacion_email"). Default `true` a
    // propósito: las cuentas creadas antes de esta funcionalidad no tienen
    // este campo guardado en Mongo, y Mongoose aplica el default al leerlas
    // — así quedan verificadas automáticamente en vez de bloqueadas de
    // golpe. Solo newUser/el alta paga (webhook) lo setean explícitamente
    // en `false` al crear la cuenta.
    emailVerified: {
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
      // Niveles de plan (ver PLAN_ORDER en config/plans.js). "free" es el
      // default: toda cuenta nueva arranca sin pagar.
      enum: ["free", "basic", "pro"],
      default: "free",
    },

    // Fin de la vigencia del plan pago. Las cuentas free y las cuentas pagas
    // anteriores a este campo pueden tenerlo en null.
    subscriptionExpiresAt: {
      type: Date,
      default: null,
    },
    sellerID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Seller",
      default: null,
    },

    // Marca histórica: la cuenta se originó vía prueba gratuita de 7 días
    // (código de vendedor). No se resetea al vencer el trial por tiempo —
    // solo cuando el cliente paga un plan real (ver paymentController.js).
    // El estado "¿está en trial ahora?" se calcula lazy combinando esto con
    // subscriptionExpiresAt (ver isTrialCurrentlyActive en config/plans.js).
    trialActive: {
      type: Boolean,
      default: false,
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
      // Sin default vacío a propósito: los tres puntos que escriben acá
      // (newUser, el alta paga vía webhook, editUser) ya validan formato
      // antes de llegar hasta el modelo — este validator es la segunda
      // barrera, no la primera. Cuentas viejas sin email válido (creadas
      // antes de este fix) no se ven afectadas: los validators de Mongoose
      // solo corren sobre los campos que un write realmente toca.
      mail: {
        type: String,
        required: [true, "contactInfo.mail es obligatorio"],
        validate: {
          validator: (v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
          message: "contactInfo.mail debe ser un email válido",
        },
      },
      number: { type: Number, default: null },
      location: { type: Object, default: {} }, // Ej: { lat, lng }
      address: { type: String, default: "" },
      social: { type: Object, default: {} }, // Ej: { instagram: "", facebook: "" }
      businessName: { type: String, default: "" }, // Nombre visible del local
      reservationMessage: { type: String, default: "" }, // Mensaje pre-cargado del botón "Reservar por WhatsApp"
    },

    // Imágenes del local (galería y foto de portada)
    media: {
      pictures: { type: [String], default: [] }, // Array de URLs
      backgroundPicture: { type: String, default: "" },
    },

    // Imágenes subidas desde el Gestor de imágenes del editor de menú que
    // todavía no fueron asignadas a ningún producto. Al asignarse, la URL
    // se saca de acá y pasa a Item.image (nunca en los dos lados a la vez)
    // — así no se duplica el dato ni hace falta listar Cloudinary en vivo.
    pendingMenuImages: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.every(isValidImageUrl),
        message: "pendingMenuImages solo puede tener URLs de Cloudinary válidas",
      },
    },

    // Horario de atención, un DayHours por día de la semana. Sin `default`
    // a propósito: si el dueño nunca lo cargó, el campo queda `undefined`
    // (no un horario 09:00-18:00 inventado) — el front trata su ausencia
    // como "sin horario cargado" y no muestra la sección. `open`/`close`
    // son strings "HH:mm"; no se valida el formato acá, se valida en
    // editUser (userController.js), mismo criterio que contactInfo.
    schedule: {
      mon: {
        enabled: { type: Boolean },
        open: { type: String },
        close: { type: String },
      },
      tue: {
        enabled: { type: Boolean },
        open: { type: String },
        close: { type: String },
      },
      wed: {
        enabled: { type: Boolean },
        open: { type: String },
        close: { type: String },
      },
      thu: {
        enabled: { type: Boolean },
        open: { type: String },
        close: { type: String },
      },
      fri: {
        enabled: { type: Boolean },
        open: { type: String },
        close: { type: String },
      },
      sat: {
        enabled: { type: Boolean },
        open: { type: String },
        close: { type: String },
      },
      sun: {
        enabled: { type: Boolean },
        open: { type: String },
        close: { type: String },
      },
    },
  },
  {
    timestamps: true, // Agrega createdAt y updatedAt automáticamente
  },
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
