const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MONTHLY_PRICE,
  contractPrice,
  pointsForMonths,
  tierForPoints,
  commissionForSale,
} = require("../src/config/sellerCommission");

test("contractPrice reproduce la tabla de totales del documento de comisiones", () => {
  assert.equal(contractPrice("basic", 1), 29999);
  assert.equal(contractPrice("basic", 3), 89997);
  assert.equal(contractPrice("basic", 6), 149995);
  assert.equal(contractPrice("basic", 12), 269991);
  assert.equal(contractPrice("pro", 1), 49999);
  assert.equal(contractPrice("pro", 3), 149997);
  assert.equal(contractPrice("pro", 6), 249995);
  assert.equal(contractPrice("pro", 12), 449991);
});

test("contractPrice lanza ante un plan o duración desconocidos", () => {
  assert.throws(() => contractPrice("premium", 1));
  assert.throws(() => contractPrice("basic", 2));
});

test("pointsForMonths coincide con los puntos asignados del PDF", () => {
  assert.equal(pointsForMonths(1), 1);
  assert.equal(pointsForMonths(3), 3);
  assert.equal(pointsForMonths(6), 5);
  assert.equal(pointsForMonths(12), 9);
});

test("tierForPoints resuelve los bordes de cada escalón", () => {
  assert.equal(tierForPoints(0).rate, 0.25);
  assert.equal(tierForPoints(49).rate, 0.25);
  assert.equal(tierForPoints(50).rate, 0.30);
  assert.equal(tierForPoints(99).rate, 0.30);
  assert.equal(tierForPoints(100).rate, 0.35);
  assert.equal(tierForPoints(250).rate, 0.35);
});

test("commissionForSale reproduce la tabla 'Ganancia neta del vendedor por cliente'", () => {
  // Plan básico, las tres columnas de nivel, las cuatro duraciones.
  assert.equal(commissionForSale("basic", 1, 0.25), 7499.75);
  assert.equal(commissionForSale("basic", 3, 0.25), 22499.25);
  assert.equal(commissionForSale("basic", 6, 0.25), 37498.75);
  assert.equal(commissionForSale("basic", 12, 0.25), 67497.75);
  assert.equal(commissionForSale("basic", 1, 0.30), 8999.7);
  assert.equal(commissionForSale("basic", 12, 0.30), 80997.3);
  assert.equal(commissionForSale("basic", 1, 0.35), 10499.65);
  assert.equal(commissionForSale("basic", 12, 0.35), 94496.85);
  // Plan pro.
  assert.equal(commissionForSale("pro", 1, 0.25), 12499.75);
  assert.equal(commissionForSale("pro", 12, 0.25), 112497.75);
  assert.equal(commissionForSale("pro", 1, 0.35), 17499.65);
  assert.equal(commissionForSale("pro", 12, 0.35), 157496.85);
});

test("MONTHLY_PRICE expone los precios base usados en el resto del cálculo", () => {
  assert.deepEqual(MONTHLY_PRICE, { basic: 29999, pro: 49999 });
});
