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

function getFeaturesForPlan(plan) {
  const idx = PLAN_ORDER.indexOf(plan);
  if (idx === -1) return [];
  return PLAN_ORDER.slice(0, idx + 1).flatMap((p) => PLAN_FEATURES[p]);
}

function hasMinPlan(userPlan, requiredPlan) {
  return PLAN_ORDER.indexOf(userPlan) >= PLAN_ORDER.indexOf(requiredPlan);
}

module.exports = { PLAN_MAP, PLAN_ORDER, PLAN_FEATURES, getFeaturesForPlan, hasMinPlan };