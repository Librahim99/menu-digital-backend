const test = require("node:test");
const assert = require("node:assert/strict");
const SellerSale = require("../src/models/SellerSale");
const {
  computeEligibility,
  summarizeCycle,
  summarizeHistoric,
  getOverviewForSellers,
  getRanking,
} = require("../src/services/sellerPanelService");

function mockSellerSaleFind(t, rows) {
  t.mock.method(SellerSale, "find", () => ({
    select() { return this; },
    sort() { return this; },
    async lean() { return rows; },
  }));
}

// ──────────────────────────────────────────────
// computeEligibility — la primera venta de un cliente siempre es elegible;
// una renovación solo es elegible si la venta anterior de ESE cliente era de
// 1 mes.
// ──────────────────────────────────────────────

test("computeEligibility: primera venta de un cliente siempre elegible", async (t) => {
  mockSellerSaleFind(t, [
    { _id: "s1", userID: "u1", months: 12, subscriptionDate: new Date("2026-01-01") },
  ]);
  const eligible = await computeEligibility(["u1"]);
  assert.deepEqual([...eligible], ["s1"]);
});

test("computeEligibility: renovación desde un plan de 1 mes es elegible", async (t) => {
  mockSellerSaleFind(t, [
    { _id: "s1", userID: "u1", months: 1, subscriptionDate: new Date("2026-01-01") },
    { _id: "s2", userID: "u1", months: 3, subscriptionDate: new Date("2026-02-01") },
  ]);
  const eligible = await computeEligibility(["u1"]);
  assert.deepEqual([...eligible].sort(), ["s1", "s2"]);
});

test("computeEligibility: renovación desde un plan de 3/6/12 meses NO es elegible", async (t) => {
  mockSellerSaleFind(t, [
    { _id: "s1", userID: "u1", months: 6, subscriptionDate: new Date("2026-01-01") },
    { _id: "s2", userID: "u1", months: 1, subscriptionDate: new Date("2026-07-01") },
  ]);
  const eligible = await computeEligibility(["u1"]);
  assert.deepEqual([...eligible], ["s1"]);
});

test("computeEligibility: una cadena de renovaciones de 1 mes es elegible completa, y se corta al pasar a un plan largo", async (t) => {
  mockSellerSaleFind(t, [
    { _id: "s1", userID: "u1", months: 1, subscriptionDate: new Date("2026-01-01") },
    { _id: "s2", userID: "u1", months: 1, subscriptionDate: new Date("2026-02-01") },
    { _id: "s3", userID: "u1", months: 12, subscriptionDate: new Date("2026-03-01") },
    // Esta renovación viene de un plan de 12 meses (s3): no elegible.
    { _id: "s4", userID: "u1", months: 1, subscriptionDate: new Date("2027-03-01") },
  ]);
  const eligible = await computeEligibility(["u1"]);
  assert.deepEqual([...eligible].sort(), ["s1", "s2", "s3"]);
});

test("computeEligibility: no mezcla el historial de clientes distintos", async (t) => {
  mockSellerSaleFind(t, [
    { _id: "s1", userID: "u1", months: 12, subscriptionDate: new Date("2026-01-01") },
    { _id: "s2", userID: "u2", months: 6, subscriptionDate: new Date("2026-01-01") },
  ]);
  const eligible = await computeEligibility(["u1", "u2"]);
  assert.deepEqual([...eligible].sort(), ["s1", "s2"]);
});

// ──────────────────────────────────────────────
// summarizeCycle — el tier se calcula UNA vez por ciclo (a partir del total
// combinado de puntos) y se aplica por igual a cada venta de ese ciclo.
// ──────────────────────────────────────────────

test("summarizeCycle calcula puntos combinados, tier único, y comisión separada por plan", () => {
  // 1 venta pro de 12 meses (9 pts) + 1 venta basic de 3 meses (3 pts) = 12
  // pts -> tier base (25%), lejos del escalón de 50.
  const sales = [
    { plan: "pro", months: 12, amount: 100000 },
    { plan: "basic", months: 3, amount: 80000 },
  ];
  const summary = summarizeCycle(sales);

  assert.equal(summary.points, 12);
  assert.equal(summary.tier.rate, 0.25);
  assert.equal(summary.basic.count, 1);
  assert.equal(summary.basic.commission, 22499.25); // 89997 * 0.25
  assert.equal(summary.pro.count, 1);
  assert.equal(summary.pro.commission, 112497.75); // 449991 * 0.25
  assert.equal(summary.total.commission, 22499.25 + 112497.75);
  assert.equal(summary.total.revenue, 180000);
});

test("summarizeCycle: alcanzar 50 puntos sube el tier de TODAS las ventas del ciclo, no solo la que cruza el umbral", () => {
  // 6 ventas de 1 mes básico (1pt c/u = 6pts) + una de 12 meses básico (9pts)
  // = 15 pts, no alcanza. Agrego suficientes para llegar a 50+.
  const sales = Array.from({ length: 50 }, () => ({ plan: "basic", months: 1, amount: 29999 }));
  const summary = summarizeCycle(sales);
  assert.equal(summary.points, 50);
  assert.equal(summary.tier.rate, 0.30);
  // Cada venta de 1 mes básico a 30%: 29999*0.30 = 8999.7
  assert.equal(summary.basic.commission, round2(50 * 8999.7));
});

function round2(n) { return Math.round(n * 100) / 100; }

test("summarizeCycle con ninguna venta devuelve todo en cero y tier base", () => {
  const summary = summarizeCycle([]);
  assert.equal(summary.points, 0);
  assert.equal(summary.tier.rate, 0.25);
  assert.deepEqual(summary.total, { count: 0, points: 0, commission: 0, revenue: 0 });
});

// ──────────────────────────────────────────────
// summarizeHistoric — suma ciclo por ciclo, cada uno con su propio tier.
// ──────────────────────────────────────────────

test("summarizeHistoric no aplica un único tier a todo el historial: cada ciclo se resuelve con sus propios puntos", () => {
  const seller = { _id: "sel1", startDate: new Date("2026-01-01T00:00:00.000Z"), createdAt: new Date("2026-01-01T00:00:00.000Z") };
  // Ciclo 0 [01/01-01/02): 1 venta pro 12m (9pts) -> tier base 25%.
  // Ciclo 1 [01/02-01/03): 60 ventas basic 1m (60pts) -> tier 30%.
  const sales = [
    { sellerID: "sel1", plan: "pro", months: 12, amount: 449991, subscriptionDate: new Date("2026-01-15") },
    ...Array.from({ length: 60 }, () => ({
      sellerID: "sel1", plan: "basic", months: 1, amount: 29999, subscriptionDate: new Date("2026-02-15"),
    })),
  ];

  const historic = summarizeHistoric(seller, sales, Infinity);

  assert.equal(historic.cyclesCount, 2);
  assert.equal(historic.pro.commission, round2(449991 * 0.25));
  assert.equal(historic.basic.count, 60);
  assert.equal(historic.basic.commission, round2(60 * 29999 * 0.30));
  assert.equal(historic.total.count, 61);
});

// ──────────────────────────────────────────────
// getOverviewForSellers / getRanking — integración liviana con SellerSale
// mockeado.
// ──────────────────────────────────────────────

test("getOverviewForSellers separa clientsSoldTotal (todo el tiempo) del ciclo actual", async (t) => {
  const seller = { _id: "sel1", name: "Ana", code: "ANA-111", active: true, startDate: new Date("2026-01-01"), createdAt: new Date("2026-01-01") };
  const now = new Date("2026-02-10T00:00:00.000Z");

  t.mock.method(SellerSale, "find", (filter) => {
    if (filter.sellerID) {
      return {
        select() { return this; },
        async lean() {
          return [
            // Ciclo anterior (elegible, primera venta del cliente).
            { _id: "s1", sellerID: "sel1", userID: "u1", plan: "basic", months: 1, amount: 29999, subscriptionDate: new Date("2026-01-05") },
            // Ciclo actual (también primera venta de otro cliente).
            { _id: "s2", sellerID: "sel1", userID: "u2", plan: "pro", months: 3, amount: 149997, subscriptionDate: new Date("2026-02-05") },
          ];
        },
      };
    }
    // computeEligibility: historial completo por userID, ambas son primeras ventas.
    return {
      select() { return this; },
      sort() { return this; },
      async lean() {
        return [
          { _id: "s1", userID: "u1", months: 1, subscriptionDate: new Date("2026-01-05") },
          { _id: "s2", userID: "u2", months: 3, subscriptionDate: new Date("2026-02-05") },
        ];
      },
    };
  });

  const [overview] = await getOverviewForSellers([seller], { now });

  assert.equal(overview.clientsSoldTotal, 2);
  assert.equal(overview.currentCycle.total.count, 1);
  assert.equal(overview.currentCycle.pro.count, 1);
});

test("getRanking period=historic sigue devolviendo tier null (no hay un único nivel para todo el historial)", async (t) => {
  const seller = { _id: "sel1", name: "Ana", code: "ANA-111", active: true, startDate: new Date("2026-01-01"), createdAt: new Date("2026-01-01") };
  const now = new Date("2026-02-10T00:00:00.000Z");

  t.mock.method(SellerSale, "find", (filter) => ({
    select() { return this; },
    sort() { return this; },
    async lean() {
      if (filter.sellerID) {
        return [{ _id: "s1", sellerID: "sel1", userID: "u1", plan: "basic", months: 1, amount: 29999, subscriptionDate: new Date("2026-01-05") }];
      }
      return [{ _id: "s1", userID: "u1", months: 1, subscriptionDate: new Date("2026-01-05") }];
    },
  }));

  const [row] = await getRanking([seller], { period: "historic", now });
  assert.equal(row.tier, null);
  assert.equal(row.basic.count, 1);
});
