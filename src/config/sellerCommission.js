// ──────────────────────────────────────────────
// Tabla de referencia FIJA para calcular comisiones de vendedores. A propósito
// desacoplada de config/plans.js / el modelo Plan (que un admin puede editar
// en cualquier momento desde /admin/plans): si la comisión se calculara con el
// precio de checkout vigente, subir un precio distorsionaría retroactivamente
// lo que ya se le debe a un vendedor por ventas pasadas. Estos números salen
// del documento "Estructura de Comisiones v6" que definió el negocio.
// ──────────────────────────────────────────────

const MONTHLY_PRICE = { basic: 29999, pro: 49999 };

// Multiplicador de precio por duración de contrato — coincide exactamente con
// los puntos que otorga esa duración (ver PDF: "Puntos Asignados").
const MULTIPLIER = { 1: 1, 3: 3, 6: 5, 12: 9 };

const MONTHS_OPTIONS = [1, 3, 6, 12];

// De mayor a menor a propósito: tierForPoints toma el primero cuyo
// minPoints sea alcanzado.
const TIERS = [
  { rate: 0.35, minPoints: 100, label: "PRO" },
  { rate: 0.30, minPoints: 50, label: "Avanzado" },
  { rate: 0.25, minPoints: 0, label: "Base" },
];

function contractPrice(plan, months) {
  const monthlyPrice = MONTHLY_PRICE[plan];
  const multiplier = MULTIPLIER[months];
  if (monthlyPrice === undefined) throw new Error(`Plan de comisión desconocido: ${plan}`);
  if (multiplier === undefined) throw new Error(`Duración de contrato desconocida: ${months}`);
  return monthlyPrice * multiplier;
}

function pointsForMonths(months) {
  const points = MULTIPLIER[months];
  if (points === undefined) throw new Error(`Duración de contrato desconocida: ${months}`);
  return points;
}

function tierForPoints(points) {
  return TIERS.find((tier) => points >= tier.minPoints);
}

function commissionForSale(plan, months, tierRate) {
  // Redondeo a centavos: contractPrice() siempre es entero, pero
  // multiplicarlo por un tierRate fraccionario (0.25/0.30/0.35) puede caer en
  // el típico error de punto flotante de JS (ej: 29999*0.3 = 8999.699999...
  // en vez de 8999.7) — no queremos que ese ruido se acumule al sumar muchas
  // ventas.
  return Math.round(contractPrice(plan, months) * tierRate * 100) / 100;
}

module.exports = {
  MONTHLY_PRICE,
  MULTIPLIER,
  MONTHS_OPTIONS,
  TIERS,
  contractPrice,
  pointsForMonths,
  tierForPoints,
  commissionForSale,
};
