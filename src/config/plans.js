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
  if (userPlan === "free" || !subscriptionExpiresAt) return userPlan;
  return new Date(subscriptionExpiresAt).getTime() > now.getTime() ? userPlan : "free";
}

module.exports = {
  PLAN_MAP, PLAN_ORDER, BOOLEAN_FEATURES, TEMPLATE_IDS,
  isValidFeatures, isValidPeriodMultipliers, getTemplateForFeatures, getEffectivePlan,
};
