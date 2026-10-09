const test = require("node:test");
const assert = require("node:assert/strict");

const OWNER = { _id: "owner-1" };
const LINE_PRICED = {
  total: 3000,
  lines: [{ itemId: "i1", title: "Pizza", categoryId: null, categoryName: null, sectionId: null, option: null, unitPrice: 1500, quantity: 2, notes: null, position: 0 }],
};

const load = (t) => {
  const sql = require("../src/orders/db/sql");
  const shifts = require("../src/orders/services/shiftService");
  const cash = require("../src/orders/services/cashService");
  const tables = require("../src/orders/services/tableSessionService");
  const tickets = require("../src/orders/services/ticketService");
  const dto = require("../src/orders/services/orderDTO");
  const catalog = require("../src/orders/services/menuCatalog");

  const inserts = [];
  const client = {
    query: async (text, params) => {
      const clean = text.replace(/\s+/g, " ").trim();
      if (clean.startsWith("SELECT coalesce(max(number)")) return { rows: [{ number: 5 }] };
      if (clean.startsWith("INSERT INTO orders")) {
        inserts.push({ text: clean, params });
        return { rows: [{ id: 99, owner_id: "owner-1" }] };
      }
      return { rows: [] };
    },
  };
  t.mock.method(sql, "withTransaction", async (fn) => fn(client));
  t.mock.method(shifts, "lockOrOpenShift", async () => ({ id: 1 }));
  t.mock.method(cash, "lockOrOpenCashSession", async () => ({ id: 2 }));
  t.mock.method(tables, "lockOrOpenTableSession", async () => ({ id: 3 }));
  t.mock.method(tickets, "syncTicketsWithOrder", async () => {});
  t.mock.method(dto, "withItems", async (rows) => rows);
  const priceSpy = t.mock.method(catalog, "priceOrderLines", async () => LINE_PRICED);

  const path = require.resolve("../src/orders/services/orderService");
  delete require.cache[path];
  t.after(() => { delete require.cache[path]; });
  return { orderService: require(path), inserts, priceSpy };
};

// Cuenta los marcadores $n distintos que usa el INSERT y que no haya huecos.
const placeholdersOf = (text) => {
  const values = text.slice(text.indexOf("VALUES"));
  return [...values.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
};

test("pedido de siempre: el INSERT no toca las columnas de pago", async (t) => {
  const { orderService, inserts, priceSpy } = load(t);
  await orderService.createOrder({
    owner: OWNER, settings: {}, source: "panel", lines: [{ itemId: "i1", quantity: 1 }], serviceType: "counter",
  });
  assert.equal(priceSpy.mock.callCount(), 1);
  assert.equal(inserts.length, 1);
  assert.doesNotMatch(inserts[0].text, /payment_mode|payment_status/);
  const used = new Set(placeholdersOf(inserts[0].text));
  assert.equal(used.size, inserts[0].params.length, "un valor por cada marcador distinto");
  assert.equal(inserts[0].params[17], 3000, "subtotal/total = $18");
});

test("pedido online: usa lo cotizado antes y guarda el pago aprobado", async (t) => {
  const { orderService, inserts, priceSpy } = load(t);
  await orderService.createOrder({
    owner: OWNER, settings: {}, source: "customer", lines: [], serviceType: "delivery",
    customer: { name: "Ana", phone: "11", address: "Calle 1", deliveryNotes: null },
    priced: LINE_PRICED, payment: { mode: "mercadopago", status: "APPROVED" },
    clientRequestId: "5f0b2c1e-3a4d-4b6f-8c7d-9e0f1a2b3c4d",
  });
  assert.equal(priceSpy.mock.callCount(), 0, "no se vuelve a cotizar: se cobró ese importe");
  const { text, params } = inserts[0];
  assert.match(text, /payment_mode, payment_status\) VALUES/);
  const used = new Set(placeholdersOf(text));
  assert.equal(used.size, params.length);
  assert.equal(params.at(-2), "mercadopago");
  assert.equal(params.at(-1), "APPROVED");
  assert.equal(params[4], "pending", "el pago aprobado no acepta el pedido: queda pendiente");
  assert.equal(params[17], 3000);
});
