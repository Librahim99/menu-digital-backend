const Plan = require("../models/Plan");
const {
  PLAN_ORDER, getSubscriptionState, isValidFeatures,
} = require("../config/plans");
const { PAYMENT_PLANS, MONTH_MULTIPLIERS } = require("../config/paymentPlans");

// Estos valores se usan EXCLUSIVAMENTE para la migración inicial. Nunca son
// un fallback de cobro si MongoDB falla o falta un documento del catálogo.
const INITIAL_PLANS = [
  { name: "free", label: "Gratis", description: "Ideal para probar", price: 0 },
  { name: "basic", label: "Básico", description: "Para locales en crecimiento", price: PAYMENT_PLANS.basic.unitPrice },
  { name: "pro", label: "Pro", description: "Máximo control", price: PAYMENT_PLANS.pro.unitPrice },
].map(plan => ({
  ...plan, discountPrice: null, currency: "ARS", periodMultipliers: { ...MONTH_MULTIPLIERS },
  // Valores de migración, nunca fallback de lectura ni herencia entre documentos.
  features: {
    menu_editor: true, qr: true, pedido_whatsapp: true, landing_page: true,
    sin_publicidad: plan.name !== "free",
    carga_masiva_excel: plan.name !== "free",
    programacion_productos: plan.name !== "free",
    menu_pdf: plan.name !== "free",
    estadisticas: plan.name === "pro",
    item_limit: plan.name === "free" ? 15 : plan.name === "basic" ? 50 : null,
    templateIds: Array.from({ length: plan.name === "free" ? 1 : plan.name === "basic" ? 5 : 15 }, (_, i) => i + 1),
  },
}));

const initializePlans = async () => {
  // El índice único y $setOnInsert hacen seguro reiniciar o escalar instancias:
  // no sobrescriben las ediciones que haya hecho el administrador.
  await Plan.init();
  for (const initial of INITIAL_PLANS) {
    await new Plan(initial).validate();
    try {
      const now = new Date();
      await Plan.updateOne({ name: initial.name }, { $setOnInsert: {
        ...initial, __v: 0, createdAt: now, updatedAt: now,
      } }, {
        upsert: true, setDefaultsOnInsert: true, timestamps: false,
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      // Otra instancia puede haber insertado el mismo nombre mientras arrancaba.
    }
  }
  // Completar solamente documentos del catálogo anterior que no tenían features.
  // No pisa configuraciones existentes, precios ni promociones.
  for (const initial of INITIAL_PLANS) {
    await Plan.updateOne({ name: initial.name, features: { $exists: false } }, {
      $set: { features: initial.features }, $inc: { __v: 1 },
    });
  }
  const plans = await Plan.find({ name: { $in: PLAN_ORDER } });
  if (plans.length !== PLAN_ORDER.length) throw new Error("Catálogo de planes incompleto");
  await Promise.all(plans.map(plan => plan.validate()));
};

const planToDTO = (document) => {
  const plan = typeof document.toObject === "function"
    ? document.toObject({ flattenMaps: true }) : document;
  const multipliers = plan.periodMultipliers instanceof Map
    ? Object.fromEntries(plan.periodMultipliers) : plan.periodMultipliers;
  // El catálogo público no tiene un vendedor validado. Por eso su precio
  // efectivo y sus totales siempre representan el cobro regular; el
  // discountPrice solo se aplica al cotizar un alta con sellerID.
  const effectivePrice = plan.price;
  return {
    name: plan.name,
    label: plan.label,
    description: plan.description,
    price: plan.price,
    discountPrice: plan.discountPrice ?? null,
    effectivePrice,
    currency: plan.currency,
    features: plan.features,
    periodMultipliers: { ...multipliers },
    billingOptions: [1, 3, 6, 12].map(months => {
      const total = Math.round(effectivePrice * multipliers[months]);
      const regularTotal = plan.price * months;
      return { months, multiplier: multipliers[months], total, regularTotal, savings: regularTotal - total };
    }),
    version: plan.__v ?? 0,
    updatedAt: plan.updatedAt || null,
  };
};

const listPlans = async () => {
  const plans = await Plan.find({ name: { $in: PLAN_ORDER } });
  if (plans.length !== PLAN_ORDER.length) throw new Error("Catálogo de planes incompleto");
  await Promise.all(plans.map(plan => plan.validate()));
  return PLAN_ORDER.map(name => planToDTO(plans.find(plan => plan.name === name)));
};

const getPlan = async (name) => {
  try {
    const stored = await Plan.findOne({ name });
    if (!stored) throw new Error("Plan no disponible en el catálogo");
    await stored.validate();
    const plan = planToDTO(stored);
    if (!isValidFeatures(plan.features)) throw new Error("Funciones de plan inválidas");
    return plan;
  } catch (error) {
    error.code = "PLAN_CATALOG_UNAVAILABLE";
    throw error;
  }
};

const getPlanForUser = (user) => getPlan(
  getSubscriptionState(user.subscription, user.subscriptionExpiresAt).effectivePlan
);

// Reutiliza la misma lectura dentro de una petición; la siguiente vuelve a MongoDB.
const getRequestPlan = async (req) => {
  if (!req.plan) req.plan = await getPlanForUser(req.user);
  return req.plan;
};

const getCheckoutQuote = async (planId, months, { withSellerDiscount = false } = {}) => {
  if (!["basic", "pro"].includes(planId) || ![1, 3, 6, 12].includes(months)) return null;
  const plan = await getPlan(planId);
  const monthly = withSellerDiscount
    ? (plan.discountPrice ?? plan.price)
    : plan.price;
  const multiplier = plan.periodMultipliers[months];
  const total = Math.round(monthly * multiplier);
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error("Importe de plan inválido");
  return {
    plan,
    title: `Menú Digital — Plan ${plan.label}`,
    description: plan.description,
    total,
    currency: plan.currency,
    version: plan.version,
    withSellerDiscount: Boolean(withSellerDiscount),
  };
};

module.exports = { INITIAL_PLANS, initializePlans, planToDTO, listPlans, getPlan, getPlanForUser, getRequestPlan, getCheckoutQuote };
