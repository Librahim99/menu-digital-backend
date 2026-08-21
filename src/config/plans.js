// MercadoPago plan_id (viene en metadata.plan_id del pago) → valor interno
// que guardamos en User.subscription. Hoy coinciden 1:1, pero mantenemos el
// mapa como capa de indirección: el webhook lo usa para validar que el
// plan_id recibido sea uno conocido antes de tocar la suscripción del user.
const PLAN_MAP = {
  basic: "basic",
  pro:   "pro",
};

// Orden de menor a mayor. hasMinPlan() compara por índice, así que el orden
// de este array ES la jerarquía de planes. "free" es el piso (sin pagar).
const PLAN_ORDER = ["free", "basic", "pro"];

// Features que DESBLOQUEA cada nivel (acumulativo vía getFeaturesForPlan:
// un plan tiene lo suyo + todo lo de los planes inferiores).
const PLAN_FEATURES = {
  free:    ["menu_editor", "qr", "pedido_whatsapp", "landing_page"],
  basic:   ["sin_publicidad", "carga_masiva_excel", "programacion_productos", "menu_pdf"],
  pro:     ["estadisticas", "dominio_personalizado", "productos_ilimitados", "resenas_integradas"]
};

// Topes de productos. `null` significa ilimitado.
const FREE_ITEM_LIMIT = 15;
const BASIC_ITEM_LIMIT = 50;
const ITEM_LIMITS = {
  free: FREE_ITEM_LIMIT,
  basic: BASIC_ITEM_LIMIT,
  pro: null,
};

// Plan mínimo requerido para usar cada template visual de la carta pública.
// Es la fuente de verdad del gating escalonado de templates: el front espeja
// este mapa (src/lib/plans.ts) para mostrar candados, y useTemplate lo valida
// del lado del servidor. Cualquier id que no esté acá se considera inválido.
//   free:    1 diseño base
//   basic:   5 diseños totales (1–5)
//   pro:     15 diseños totales (1–15)
const TEMPLATE_MIN_PLAN = {
  1: "free",
  2: "basic", 3: "basic", 4: "basic", 5: "basic",
  6: "pro", 7: "pro", 8: "pro", 9: "pro", 10: "pro",
  11: "pro", 12: "pro", 13: "pro", 14: "pro", 15: "pro",
};

function getFeaturesForPlan(plan) {
  const idx = PLAN_ORDER.indexOf(plan);
  if (idx === -1) return [];
  return PLAN_ORDER.slice(0, idx + 1).flatMap((p) => PLAN_FEATURES[p]);
}

function hasMinPlan(userPlan, requiredPlan) {
  const userIndex = PLAN_ORDER.indexOf(userPlan);
  const requiredIndex = PLAN_ORDER.indexOf(requiredPlan);
  return userIndex !== -1 && requiredIndex !== -1 && userIndex >= requiredIndex;
}

function getItemLimit(plan) {
  return Object.prototype.hasOwnProperty.call(ITEM_LIMITS, plan)
    ? ITEM_LIMITS[plan]
    : FREE_ITEM_LIMIT;
}

function getTemplateForPlan(template, plan) {
  const requiredPlan = TEMPLATE_MIN_PLAN[template];
  return requiredPlan && hasMinPlan(plan, requiredPlan) ? template : 1;
}

// Compatibilidad: los usuarios pagos creados antes de incorporar vencimientos
// no tienen subscriptionExpiresAt y conservan su plan actual.
function getEffectivePlan(userPlan, subscriptionExpiresAt, now = new Date()) {
  if (userPlan === "free" || !subscriptionExpiresAt) return userPlan;
  return new Date(subscriptionExpiresAt).getTime() > now.getTime() ? userPlan : "free";
}

module.exports = {
  PLAN_MAP,
  PLAN_ORDER,
  PLAN_FEATURES,
  FREE_ITEM_LIMIT,
  BASIC_ITEM_LIMIT,
  ITEM_LIMITS,
  TEMPLATE_MIN_PLAN,
  getFeaturesForPlan,
  getItemLimit,
  getTemplateForPlan,
  getEffectivePlan,
  hasMinPlan,
};
