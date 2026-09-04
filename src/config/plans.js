// MercadoPago plan_id (viene en metadata.plan_id del pago) → valor interno
// que guardamos en User.subscription. Hoy coinciden 1:1, pero mantenemos el
// mapa como capa de indirección: el webhook lo usa para validar que el
// plan_id recibido sea uno conocido antes de tocar la suscripción del user.
const PLAN_MAP = {
  basic: "basic",
  pro:   "pro",
};

// Orden comercial para upgrades; no concede funcionalidades por jerarquía.
const PLAN_ORDER = ["free", "basic", "pro"];

// Contrato técnico de funcionalidades implementadas; no asigna permisos a planes.
// Las asignaciones, límites y selección de templates viven en la colección plans.
const BOOLEAN_FEATURES = [
  "menu_editor", "qr", "pedido_whatsapp", "landing_page", "sin_publicidad",
  "carga_masiva_excel", "programacion_productos", "menu_pdf", "estadisticas",
];
const TEMPLATE_IDS = Array.from({ length: 15 }, (_, index) => index + 1);
const hasSubscriptionExpiry = (value) => value !== null && value !== undefined && value !== "";

const isValidFeatures = (features) => features && typeof features === "object"
  && !Array.isArray(features)
  && Object.keys(features).length === BOOLEAN_FEATURES.length + 2
  && BOOLEAN_FEATURES.every(key => typeof features[key] === "boolean")
  && (features.item_limit === null || (Number.isSafeInteger(features.item_limit) && features.item_limit > 0))
  && Array.isArray(features.templateIds) && features.templateIds.length > 0
  && new Set(features.templateIds).size === features.templateIds.length
  && features.templateIds.every(id => TEMPLATE_IDS.includes(id));

const isValidPeriodMultipliers = (multipliers) => multipliers && typeof multipliers === "object"
  && !Array.isArray(multipliers)
  && [Object.prototype, null].includes(Object.getPrototypeOf(multipliers))
  && Object.keys(multipliers).length === 4
  && multipliers[1] === 1
  && [1, 3, 6, 12].every(months => Object.prototype.hasOwnProperty.call(multipliers, months)
    && Number.isFinite(multipliers[months]) && multipliers[months] > 0 && multipliers[months] <= months);

const getTemplateForFeatures = (template, features) =>
  features.templateIds.includes(template) ? template : features.templateIds[0];

// Compatibilidad: los usuarios pagos creados antes de incorporar vencimientos
// no tienen subscriptionExpiresAt y conservan su plan actual.
function getEffectivePlan(userPlan, subscriptionExpiresAt, now = new Date()) {
  if (userPlan === "free" || !hasSubscriptionExpiry(subscriptionExpiresAt)) {
    return userPlan;
  }
  return new Date(subscriptionExpiresAt).getTime() > now.getTime() ? userPlan : "free";
}

// Estado de suscripción que consumen los paneles. El plan guardado conserva
// el último plan comprado (sirve para historial y renovación), mientras que
// effectivePlan es el único plan que debe usarse para permisos y features.
// Los pagos históricos sin fecha siguen activos por compatibilidad: son
// cuentas creadas antes de incorporar vencimientos.
function getSubscriptionState(userPlan, subscriptionExpiresAt, now = new Date()) {
  const isPaidPlan = userPlan === "basic" || userPlan === "pro";
  const effectivePlan = getEffectivePlan(userPlan, subscriptionExpiresAt, now);

  if (userPlan === "free") {
    return {
      storedPlan: userPlan,
      effectivePlan,
      subscriptionStatus: "free",
      previousSubscription: null,
      downgradeReason: null,
      downgradedAt: null,
    };
  }

  // No mutamos la cuenta: un paid legacy sin fecha de vencimiento permanece
  // activo hasta que una renovación le asigne una fecha explícita.
  if (!isPaidPlan || !hasSubscriptionExpiry(subscriptionExpiresAt)) {
    return {
      storedPlan: userPlan,
      effectivePlan,
      subscriptionStatus: effectivePlan === "free" ? "free" : "active",
      previousSubscription: null,
      downgradeReason: null,
      downgradedAt: null,
    };
  }

  const expiryMs = new Date(subscriptionExpiresAt).getTime();
  const expired = !Number.isFinite(expiryMs) || expiryMs <= now.getTime();
  if (!expired) {
    return {
      storedPlan: userPlan,
      effectivePlan,
      subscriptionStatus: "active",
      previousSubscription: null,
      downgradeReason: null,
      downgradedAt: null,
    };
  }

  return {
    storedPlan: userPlan,
    effectivePlan: "free",
    subscriptionStatus: "expired",
    previousSubscription: isPaidPlan ? userPlan : null,
    downgradeReason: "subscription_expired",
    // Una fecha inválida se mantiene como null, pero igual falla cerrando en
    // Free y queda visible como vencida para que el admin pueda corregirla.
    downgradedAt: Number.isFinite(expiryMs) ? new Date(expiryMs) : null,
  };
}

module.exports = {
  PLAN_MAP, PLAN_ORDER, BOOLEAN_FEATURES, TEMPLATE_IDS,
  isValidFeatures, isValidPeriodMultipliers, getTemplateForFeatures,
  getEffectivePlan, getSubscriptionState,
};
