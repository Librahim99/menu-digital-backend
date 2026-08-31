const mongoose = require("mongoose");
const { PLAN_ORDER, BOOLEAN_FEATURES, TEMPLATE_IDS, isValidPeriodMultipliers } = require("../config/plans");

const featuresSchema = new mongoose.Schema({
  ...Object.fromEntries(BOOLEAN_FEATURES.map(key => [key, { type: Boolean, required: true }])),
  item_limit: {
    type: Number,
    default: undefined,
    validate: value => value === null || (Number.isSafeInteger(value) && value > 0),
  },
  templateIds: {
    type: [Number], required: true, default: undefined,
    validate: ids => Array.isArray(ids) && ids.length > 0
      && new Set(ids).size === ids.length && ids.every(id => TEMPLATE_IDS.includes(id)),
  },
}, { _id: false, strict: "throw" });

featuresSchema.pre("validate", function () {
  if (this.item_limit === undefined) this.invalidate("item_limit", "Indicá un límite o null para ilimitado.");
});

// Los identificadores siguen siendo los mismos que User.subscription.
// La administración modifica el catálogo, nunca renombra ni elimina planes.
const planSchema = new mongoose.Schema({
  name: { type: String, enum: PLAN_ORDER, required: true, immutable: true, unique: true },
  label: { type: String, required: true, trim: true, maxlength: 60 },
  description: { type: String, required: true, trim: true, maxlength: 280 },
  price: { type: Number, required: true, min: 0, max: 100000000, validate: Number.isSafeInteger },
  discountPrice: {
    type: Number,
    default: null,
    validate: {
      validator(value) {
        return value === null || (Number.isSafeInteger(value) && value > 0 && value < this.price);
      },
      message: "El precio promocional debe ser positivo y menor al precio de lista.",
    },
  },
  currency: { type: String, enum: ["ARS"], default: "ARS", required: true, immutable: true },
  features: { type: featuresSchema, required: true },
  periodMultipliers: {
    type: Map,
    of: Number,
    required: true,
    validate: {
      validator(value) {
        const entries = value instanceof Map ? Object.fromEntries(value) : value;
        return isValidPeriodMultipliers(entries);
      },
      message: "Los períodos deben ser 1, 3, 6 y 12 meses con multiplicadores válidos.",
    },
  },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true, optimisticConcurrency: true });

planSchema.pre("validate", function () {
  if (this.name === "free" && (this.price !== 0 || this.discountPrice !== null)) {
    this.invalidate("price", "El plan gratuito debe conservar precio cero y no admite promoción.");
  }
  if (this.name !== "free" && !(this.price > 0)) {
    this.invalidate("price", "Los planes pagos deben tener un precio positivo.");
  }
  if (this.name !== "free" && this.periodMultipliers instanceof Map
    && [...this.periodMultipliers.values()].some(multiplier => Math.round((this.discountPrice ?? this.price) * multiplier) < 1)) {
    this.invalidate("periodMultipliers", "Cada período pago debe costar al menos un peso.");
  }
});

module.exports = mongoose.model("Plan", planSchema);
