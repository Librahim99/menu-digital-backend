const test = require("node:test");
const assert = require("node:assert/strict");

const ROW = {
  owner_id: "owner-1", qr_mode: "general", customer_ordering: true, customer_history: true, table_count: 5,
  period_mode: "shift", shift_schedule: [], options: {},
};

// settingsService desestructura db/sql al cargarse: se parcha antes de requerirlo.
const load = (t) => {
  const sql = require("../src/orders/db/sql");
  const updates = [];
  const run = async (text, params) => {
    const q = text.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT * FROM order_settings")) return { rows: [ROW] };
    if (q.startsWith("UPDATE order_settings")) {
      updates.push(JSON.parse(params[7]));
      return { rows: [{ ...ROW, options: JSON.parse(params[7]) }] };
    }
    return { rows: [] };
  };
  t.mock.method(sql, "query", run);
  t.mock.method(sql, "withTransaction", async (fn) => fn({ query: run }));
  const path = require.resolve("../src/orders/services/settingsService");
  delete require.cache[path];
  t.after(() => { delete require.cache[path]; });
  return { service: require(path), updates };
};

test("tiempo estimado: se guardan mínimo y máximo juntos", async (t) => {
  const { service, updates } = load(t);
  await service.updateSettings("owner-1", { options: { prepMinMinutes: 10, prepMaxMinutes: 25 } });
  assert.equal(updates[0].prepMinMinutes, 10);
  assert.equal(updates[0].prepMaxMinutes, 25);
});

test("tiempo estimado: los dos en 0 significa sin estimación", async (t) => {
  const { service, updates } = load(t);
  await service.updateSettings("owner-1", { options: { prepMinMinutes: 0, prepMaxMinutes: 0 } });
  assert.equal(updates.length, 1);
});

test("tiempo estimado: uno solo, máximo menor al mínimo o fuera de rango se rechazan", async (t) => {
  const { service, updates } = load(t);
  for (const options of [
    { prepMinMinutes: 10 },
    { prepMaxMinutes: 25 },
    { prepMinMinutes: 30, prepMaxMinutes: 20 },
    { prepMinMinutes: 10, prepMaxMinutes: 601 },
    { prepMinMinutes: -1, prepMaxMinutes: 10 },
    { prepMinMinutes: "abc", prepMaxMinutes: 10 },
  ]) {
    await assert.rejects(service.updateSettings("owner-1", { options }), (e) => e.status === 400, JSON.stringify(options));
  }
  assert.equal(updates.length, 0, "nada se guarda ante un valor inválido");
});

test("tiempo estimado: igual mínimo y máximo es válido", async (t) => {
  const { service } = load(t);
  await service.updateSettings("owner-1", { options: { prepMinMinutes: 20, prepMaxMinutes: 20 } });
});
