const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cycleAnchor,
  cycleWindowAtOffset,
  currentCycleWindow,
} = require("../src/utils/sellerCycle");

test("cycleAnchor usa startDate cuando existe", () => {
  const seller = {
    startDate: new Date("2026-03-15T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  assert.equal(cycleAnchor(seller).toISOString(), "2026-03-15T00:00:00.000Z");
});

test("cycleAnchor cae a createdAt si no hay startDate (vendedores legacy)", () => {
  const seller = { startDate: null, createdAt: new Date("2026-01-05T00:00:00.000Z") };
  assert.equal(cycleAnchor(seller).toISOString(), "2026-01-05T00:00:00.000Z");
});

test("cycleWindowAtOffset arma ventanas consecutivas de un mes calendario", () => {
  const anchor = new Date("2026-01-15T00:00:00.000Z");
  const w0 = cycleWindowAtOffset(anchor, 0);
  assert.equal(w0.start.toISOString(), "2026-01-15T00:00:00.000Z");
  assert.equal(w0.end.toISOString(), "2026-02-15T00:00:00.000Z");

  const w1 = cycleWindowAtOffset(anchor, 1);
  assert.equal(w1.start.toISOString(), w0.end.toISOString());

  const wMinus1 = cycleWindowAtOffset(anchor, -1);
  assert.equal(wMinus1.end.toISOString(), w0.start.toISOString());
});

test("currentCycleWindow encuentra la ventana que contiene `now`", () => {
  const anchor = new Date("2026-01-15T00:00:00.000Z");

  const midCycle = currentCycleWindow(anchor, new Date("2026-03-20T00:00:00.000Z"));
  assert.equal(midCycle.start.toISOString(), "2026-03-15T00:00:00.000Z");
  assert.equal(midCycle.end.toISOString(), "2026-04-15T00:00:00.000Z");
  assert.equal(midCycle.offset, 2);

  // Justo en el instante de corte: pertenece a la ventana que empieza ahí,
  // no a la anterior.
  const onBoundary = currentCycleWindow(anchor, new Date("2026-03-15T00:00:00.000Z"));
  assert.equal(onBoundary.offset, 2);

  // Un instante antes del corte todavía pertenece al ciclo previo.
  const justBefore = currentCycleWindow(anchor, new Date("2026-03-14T23:59:59.999Z"));
  assert.equal(justBefore.offset, 1);

  // `now` anterior al ancla misma (vendedor recién creado, primer ciclo
  // todavía no arrancó formalmente) debe resolver a offset negativo, no
  // reventar. 2025-12-01 cae antes del corte del 15, así que pertenece al
  // ciclo que arrancó el 15/11, no al que arranca el 15/12.
  const beforeAnchor = currentCycleWindow(anchor, new Date("2025-12-01T00:00:00.000Z"));
  assert.equal(beforeAnchor.offset, -2);
  assert.equal(beforeAnchor.start.toISOString(), "2025-11-15T00:00:00.000Z");
  assert.equal(beforeAnchor.end.toISOString(), "2025-12-15T00:00:00.000Z");
});

test("currentCycleWindow clampea un ancla en día 31 al cruzar a febrero", () => {
  const anchor = new Date("2026-01-31T00:00:00.000Z");
  // offset 0: 31/01 -> 28/02/2026 (2026 no es bisiesto).
  const w0 = cycleWindowAtOffset(anchor, 0);
  assert.equal(w0.start.toISOString(), "2026-01-31T00:00:00.000Z");
  assert.equal(w0.end.toISOString(), "2026-02-28T00:00:00.000Z");

  const now = new Date("2026-02-20T00:00:00.000Z");
  const found = currentCycleWindow(anchor, now);
  assert.equal(found.offset, 0);
  assert.equal(found.end.toISOString(), "2026-02-28T00:00:00.000Z");
});
