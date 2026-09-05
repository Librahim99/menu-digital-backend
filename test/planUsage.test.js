const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const PaymentTransaction = require("../src/models/PaymentTransaction");
const { getPlanUsage } = require("../src/controllers/planController");

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    set(key, value) {
      this.headers[key] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

const future = new Date(Date.now() + (60 * 24 * 60 * 60 * 1000));
const past = new Date(Date.now() - (60 * 24 * 60 * 60 * 1000));

test("getPlanUsage cuenta por plan efectivo: una suscripción vencida no sigue contando como paga", async (t) => {
  t.mock.method(User, "find", () => ({
    select: async () => [
      { subscription: "pro", subscriptionExpiresAt: future, active: true },
      { subscription: "basic", subscriptionExpiresAt: future, active: true },
      // Vencida: aunque en la base diga "pro", hoy es una cuenta free.
      { subscription: "pro", subscriptionExpiresAt: past, active: true },
      { subscription: "free", subscriptionExpiresAt: null, active: false },
    ],
  }));
  t.mock.method(PaymentTransaction, "aggregate", async () => []);

  const res = response();
  await getPlanUsage({}, res);

  assert.equal(res.statusCode, 200);
  const byName = Object.fromEntries(res.body.usage.map((row) => [row.name, row]));
  assert.equal(byName.pro.accounts, 1);
  assert.equal(byName.basic.accounts, 1);
  // La vencida y la gratuita real.
  assert.equal(byName.free.accounts, 2);
  // Solo una de las dos cuentas free está activa.
  assert.equal(byName.free.activeAccounts, 1);
});

test("getPlanUsage devuelve la facturación por plan y no cachea la respuesta", async (t) => {
  t.mock.method(User, "find", () => ({ select: async () => [] }));
  t.mock.method(PaymentTransaction, "aggregate", async () => [
    { _id: "pro", revenueTotal: 250000, revenue30d: 40000, payments: 12 },
    { _id: "basic", revenueTotal: 90000, revenue30d: 15000, payments: 9 },
  ]);

  const res = response();
  await getPlanUsage({}, res);

  const byName = Object.fromEntries(res.body.usage.map((row) => [row.name, row]));
  assert.equal(byName.pro.revenueTotal, 250000);
  assert.equal(byName.pro.revenue30d, 40000);
  assert.equal(byName.pro.payments, 12);
  assert.equal(byName.basic.revenueTotal, 90000);
  // Un plan sin pagos responde en cero, no undefined: el frontend formatea
  // el número sin chequear existencia.
  assert.equal(byName.free.revenueTotal, 0);
  assert.equal(byName.free.payments, 0);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("getPlanUsage responde 500 controlado si falla la base", async (t) => {
  t.mock.method(User, "find", () => ({
    select: async () => { throw new Error("db caída"); },
  }));
  t.mock.method(PaymentTransaction, "aggregate", async () => []);

  const res = response();
  await getPlanUsage({}, res);

  assert.equal(res.statusCode, 500);
});
