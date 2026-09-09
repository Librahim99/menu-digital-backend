const test = require("node:test");
const assert = require("node:assert/strict");
const { isTrialCurrentlyActive } = require("../src/config/plans");

test("isTrialCurrentlyActive combina la marca histórica con el vencimiento, sin necesitar un cron", () => {
  const now = new Date("2026-09-09T12:00:00.000Z");
  const futuro = new Date("2026-09-12T12:00:00.000Z");
  const pasado = new Date("2026-09-01T12:00:00.000Z");

  // En trial vigente.
  assert.equal(isTrialCurrentlyActive(true, futuro, now), true);

  // Trial vencido: la marca sigue en true en el User (solo se resetea al
  // pagar), pero el estado "ahora" ya es false.
  assert.equal(isTrialCurrentlyActive(true, pasado, now), false);

  // Nunca estuvo en trial.
  assert.equal(isTrialCurrentlyActive(false, futuro, now), false);
  assert.equal(isTrialCurrentlyActive(undefined, futuro, now), false);

  // Sin fecha de vencimiento (no debería pasar en la práctica — el trial
  // siempre la asigna al crear la cuenta — pero falla cerrado igual).
  assert.equal(isTrialCurrentlyActive(true, null, now), false);
  assert.equal(isTrialCurrentlyActive(true, undefined, now), false);
});
