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
  free:    [],
  basic:   ["menu_limitado", "landing_page", "carga_masiva_excel"],
  pro:     ["estadisticas", "dominio_personalizado"]
};

// Tope de productos del plan gratuito (coincide con lo que promete la
// landing pública: "Hasta 15 productos"). A partir de "basic" (feature
// "menu_limitado") no hay tope — no es un límite escalonado por plan,
// es binario: free vs. cualquier plan pago.
const FREE_ITEM_LIMIT = 15;

// Plan mínimo requerido para usar cada template visual de la carta pública.
// Es la fuente de verdad del gating escalonado de templates: el front espeja
// este mapa (src/lib/plans.ts) para mostrar candados, y useTemplate lo valida
// del lado del servidor. Cualquier id que no esté acá se considera inválido.
//   free:    1 Clásico · 3 Natural · 5 Minimal
//   basic:   2 Moderno · 4 Rojo · 8 Coastal · 9 Charcoal
//   pro:     10 Terracotta · 11 Lavender · 12 Forest
const TEMPLATE_MIN_PLAN = {
  1: "free",    3: "free",    5: "free",
  2: "basic", 4: "basic", 8: "basic", 9: "basic",
  10: "pro",    11: "pro",    12: "pro",
  6: "pro", 7: "pro", 13: "pro",
};

function getFeaturesForPlan(plan) {
  const idx = PLAN_ORDER.indexOf(plan);
  if (idx === -1) return [];
  return PLAN_ORDER.slice(0, idx + 1).flatMap((p) => PLAN_FEATURES[p]);
}

function hasMinPlan(userPlan, requiredPlan) {
  return PLAN_ORDER.indexOf(userPlan) >= PLAN_ORDER.indexOf(requiredPlan);
}

module.exports = { PLAN_MAP, PLAN_ORDER, PLAN_FEATURES, FREE_ITEM_LIMIT, TEMPLATE_MIN_PLAN, getFeaturesForPlan, hasMinPlan };