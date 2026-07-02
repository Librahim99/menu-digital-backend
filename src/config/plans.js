const PLAN_MAP = {
  mensual: "monthly",
  semestral: "semestral",
  anual: "annual",
};

const PLAN_ORDER = ["none", "monthly", "semestral", "annual"];

const PLAN_FEATURES = {
  none:      [],
  monthly:   ["menu_ilimitado", "landing_page", "carga_masiva_excel"],
  semestral: ["estadisticas"],
  annual:    ["dominio_personalizado"],
};

// Tope de productos del plan gratuito (coincide con lo que promete la
// landing pública: "Hasta 15 productos"). A partir de "monthly" (feature
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