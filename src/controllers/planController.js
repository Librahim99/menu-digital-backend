const Plan = require("../models/Plan");
const catalog = require("../services/planCatalog");
const { PLAN_ORDER, isValidFeatures, isValidPeriodMultipliers } = require("../config/plans");
const { handleError } = require("../utils/handleError");

const listPlans = async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    return res.json({ plans: await catalog.listPlans() });
  } catch (error) {
    return handleError(res, error, 503);
  }
};

const updatePlan = async (req, res) => {
  const { name } = req.params;
  if (!PLAN_ORDER.includes(name)) return res.status(404).json({ message: "Plan no encontrado." });
  const body = req.body;
  if (!body || Array.isArray(body) || typeof body !== "object"
    || Object.keys(body).some(key => !["price", "discountPrice", "version", "features", "label", "description", "periodMultipliers"].includes(key))
    || !isValidFeatures(body.features)
    || typeof body.label !== "string" || !body.label.trim() || body.label.trim().length > 60
    || typeof body.description !== "string" || !body.description.trim() || body.description.trim().length > 280
    || !Number.isSafeInteger(body.version) || body.version < 0
    || !Number.isSafeInteger(body.price) || body.price < 0 || body.price > 100000000
    || !(body.discountPrice === null || (Number.isSafeInteger(body.discountPrice)
      && body.discountPrice > 0 && body.discountPrice < body.price))
    || (name === "free" ? body.price !== 0 || body.discountPrice !== null : body.price === 0)) {
    return res.status(400).json({ message: "Revisá nombre, descripción, precios y funciones. Usá pesos enteros, límite positivo o ilimitado y al menos un template válido; Gratis conserva precio cero." });
  }
  const hasPeriodMultipliers = Object.prototype.hasOwnProperty.call(body, "periodMultipliers");
  if (hasPeriodMultipliers && (!isValidPeriodMultipliers(body.periodMultipliers)
    || (name !== "free" && Object.values(body.periodMultipliers)
      .some(multiplier => Math.round((body.discountPrice ?? body.price) * multiplier) < 1)))) {
    return res.status(400).json({ message: "Revisá los multiplicadores de 1, 3, 6 y 12 meses: el mensual debe ser 1 y los demás, números positivos hasta la cantidad de meses. Cada período pago debe costar al menos un peso." });
  }
  try {
    const current = await Plan.findOne({ name });
    if (!current) return res.status(404).json({ message: "Plan no encontrado." });
    if ((current.__v ?? 0) !== body.version) {
      return res.status(409).json({ message: "El plan cambió mientras lo editabas. Recargá los datos antes de guardar." });
    }
    current.price = body.price;
    current.discountPrice = body.discountPrice;
    current.features = body.features;
    current.label = body.label;
    current.description = body.description;
    // Los clientes anteriores pueden omitir el mapa; no restablecerlo al guardar.
    if (hasPeriodMultipliers) current.periodMultipliers = body.periodMultipliers;
    current.updatedBy = req.user._id;
    await current.save(); // optimisticConcurrency comprueba __v de forma atómica.
    res.set("Cache-Control", "no-store");
    return res.json({ plan: catalog.planToDTO(current) });
  } catch (error) {
    if (error.name === "VersionError") {
      return res.status(409).json({ message: "Otro administrador actualizó el plan. Recargá los datos antes de guardar." });
    }
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: "La configuración del plan no es válida." });
    }
    return handleError(res, error);
  }
};

module.exports = { listPlans, updatePlan };
