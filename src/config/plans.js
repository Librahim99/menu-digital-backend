// MercadoPago plan_id (viene en metadata.plan_id del pago) → valor interno
// que guardamos en User.subscription. Hoy coinciden 1:1, pero mantenemos el
// mapa como capa de indirección: el webhook lo usa para validar que el
// plan_id recibido sea uno conocido antes de tocar la suscripción del user.
const PLAN_MAP = {
  starter: "starter",
  pro:     "pro",
  premium: "premium",
};

// Orden de menor a mayor. hasMinPlan() compara por índice, así que el orden
// de este array ES la jerarquía de planes. "free" es el piso (sin pagar).
const PLAN_ORDER = ["free", "starter", "pro", "premium"];

// Features que DESBLOQUEA cada nivel (acumulativo vía getFeaturesForPlan:
// un plan tiene lo suyo + todo lo de los planes inferiores).
const PLAN_FEATURES = {
  free:    [],
  starter: ["menu_ilimitado", "landing_page", "carga_masiva_excel"],
  pro:     ["estadisticas"],
  premium: ["dominio_personalizado"],
};

// Tope de productos del plan gratuito (coincide con lo que promete la
// landing pública: "Hasta 15 productos"). A partir de "starter" (feature
// "menu_ilimitado") no hay tope — no es un límite escalonado por plan,
// es binario: free vs. cualquier plan pago.
const FREE_ITEM_LIMIT = 15;

function getFeaturesForPlan(plan) {
  const idx = PLAN_ORDER.indexOf(plan);
  if (idx === -1) return [];
  return PLAN_ORDER.slice(0, idx + 1).flatMap((p) => PLAN_FEATURES[p]);
}

function hasMinPlan(userPlan, requiredPlan) {
  return PLAN_ORDER.indexOf(userPlan) >= PLAN_ORDER.indexOf(requiredPlan);
}

module.exports = { PLAN_MAP, PLAN_ORDER, PLAN_FEATURES, FREE_ITEM_LIMIT, getFeaturesForPlan, hasMinPlan };