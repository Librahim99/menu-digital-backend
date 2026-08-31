const PAYMENT_CURRENCY = "ARS";

// Valores históricos para inicializar documentos que todavía no existen.
// El checkout consulta services/planCatalog; estos importes NO son un fallback.
// El webhook valida el snapshot guardado, nunca recalcula el precio vigente.
const PAYMENT_PLANS = {
  basic: {
    title: "Menú Digital — Plan Basic",
    unitPrice: 29999,
    description: "Hasta 50 productos, sin publicidad, Excel, programación, PDF y 5 diseños",
  },
  pro: {
    title: "Menú Digital — Plan Pro",
    unitPrice: 49999,
    description: "Productos ilimitados, métricas y 15 diseños",
  },
};

const MONTH_MULTIPLIERS = {
  1: 1,
  3: 2.7,
  6: 5,
  12: 9,
};

const VALID_PAYMENT_MONTHS = Object.freeze(
  Object.keys(MONTH_MULTIPLIERS).map(Number)
);

const getCheckoutAmount = (planId, months) => {
  const plan = PAYMENT_PLANS[planId];
  const multiplier = MONTH_MULTIPLIERS[Number(months)];
  if (!plan || multiplier === undefined) return null;
  return Math.round(plan.unitPrice * multiplier);
};

module.exports = {
  PAYMENT_CURRENCY,
  PAYMENT_PLANS,
  MONTH_MULTIPLIERS,
  VALID_PAYMENT_MONTHS,
  getCheckoutAmount,
};
