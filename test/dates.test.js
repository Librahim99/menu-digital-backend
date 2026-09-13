const test = require("node:test");
const assert = require("node:assert/strict");
const { startOfMonthBA } = require("../src/utils/dates");

// startOfMonthBA no debe depender de la TZ del proceso: en Node, cambiar
// process.env.TZ en caliente sí cambia lo que devuelven los métodos locales
// de Date (getFullYear/getMonth/...), que es exactamente el bug que este
// helper reemplaza (new Date(now.getFullYear(), now.getMonth(), 1) usaba esos
// métodos). Probamos bajo varias TZ de proceso para confirmar que el
// resultado no cambia.
test("startOfMonthBA da el mismo instante sin importar la TZ del proceso", (t) => {
  const originalTZ = process.env.TZ;
  t.after(() => {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  });

  // 2026-09-30 23:00 hora Buenos Aires == 2026-10-01T02:00:00.000Z.
  // Para un proceso en TZ=UTC ya es "1 de octubre"; para uno en TZ de Buenos
  // Aires todavía es "30 de septiembre". El inicio de mes correcto (según
  // Buenos Aires) es el mismo instante en ambos casos.
  const lastNightOfSeptemberBA = new Date("2026-10-01T02:00:00.000Z");
  const expectedSeptemberStartBA = new Date("2026-09-01T03:00:00.000Z");

  for (const tz of ["UTC", "America/Argentina/Buenos_Aires", "Asia/Tokyo", "America/Los_Angeles"]) {
    process.env.TZ = tz;
    assert.equal(
      startOfMonthBA(lastNightOfSeptemberBA).getTime(),
      expectedSeptemberStartBA.getTime(),
      `TZ=${tz} debería dar el inicio de septiembre en horario de Buenos Aires`,
    );
  }
});

test("startOfMonthBA calcula el inicio del mes en curso", (t) => {
  process.env.TZ = "UTC";
  t.after(() => { delete process.env.TZ; });

  // 2026-01-15T12:00:00Z en Buenos Aires (UTC-3) es 2026-01-15 09:00, bien
  // adentro de enero: el inicio de mes es el 1/1 a las 00:00 BA (03:00 UTC).
  const result = startOfMonthBA(new Date("2026-01-15T12:00:00.000Z"));
  assert.equal(result.toISOString(), "2026-01-01T03:00:00.000Z");
});
