const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const User = require("../src/models/User");
const Seller = require("../src/models/Seller");
const Menu = require("../src/models/Menu");
const Item = require("../src/models/Item");
const CrmProfile = require("../src/models/CrmProfile");
const PaymentTransaction = require("../src/models/PaymentTransaction");
const PageView = require("../src/models/PageView");
const {
  listClients, getClient, updateProfile, addNote, deleteNote, getOverdueCount, markAlertsSeen,
} = require("../src/controllers/crmController");
const crmRouter = require("../src/routes/crmRoutes");

const seller = { _id: "64f000000000000000000901", name: "Responsable", code: "VEN-001" };
const influencer = { _id: "64f000000000000000000902", name: "Influencer", code: "INF-001" };
const peerID = "64f000000000000000000903";
const client = (suffix, attribution) => ({
  _id: `64f000000000000000000${suffix}`, username: `cliente-${suffix}`,
  admin: false, subscription: "free", active: true, createdAt: new Date(),
  ...attribution,
});
const clients = [
  client("101", { sellerID: seller._id }),
  client("102", { sellerID: influencer._id, influencerReferral: true, assignedSeller: seller._id }),
  client("103", { sellerID: influencer._id, influencerReferral: true, assignedSeller: peerID }),
  client("104", { sellerID: influencer._id, influencerReferral: true, assignedSeller: null }),
  client("105", { sellerID: seller._id, admin: true }),
];
const response = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

// Emula los predicados de identidad usados por las consultas para comprobar
// resultados autorizados, incluyendo clientes ajenos y cuentas admin.
const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
  if (key === "$or") return value.some((branch) => matches(row, branch));
  if (value && typeof value === "object" && "$ne" in value) return row[key] !== value.$ne;
  return row[key] === value;
});

const mockClientLookup = (t) => {
  t.mock.method(User, "find", (filter) => ({
    select() { return this; },
    async sort() { return clients.filter((row) => matches(row, filter)); },
    async distinct(field) { return clients.filter((row) => matches(row, filter)).map((row) => row[field]); },
  }));
  t.mock.method(User, "findOne", (filter) => ({
    select: async () => clients.find((row) => matches(row, filter)) || null,
  }));
  t.mock.method(User, "exists", async (filter) => {
    const row = clients.find((entry) => matches(entry, filter));
    return row ? { _id: row._id } : null;
  });
};

test("CRM: el vendedor ve sus directos y asignados; admin también ve referidos pendientes", async (t) => {
  mockClientLookup(t);
  t.mock.method(CrmProfile, "find", () => ({ select: async () => [] }));
  t.mock.method(Menu, "find", () => ({ select: async () => [] }));
  t.mock.method(PaymentTransaction, "aggregate", async () => []);
  t.mock.method(PageView, "aggregate", async () => []);
  t.mock.method(Seller, "find", () => ({ select: async () => [seller, influencer] }));

  const sellerRes = response();
  await listClients({ seller }, sellerRes);
  assert.equal(sellerRes.statusCode, 200);
  assert.deepEqual(sellerRes.body.clients.map((row) => row._id), clients.slice(0, 2).map((row) => row._id));
  assert.equal(sellerRes.body.clients[0].leadSource, "seller");
  const referred = sellerRes.body.clients[1];
  assert.equal(referred.leadSource, "influencer");
  assert.deepEqual(referred.seller, influencer);
  assert.deepEqual(referred.assignedSeller, seller);

  const adminRes = response();
  await listClients({ user: { admin: true } }, adminRes);
  assert.equal(adminRes.body.clients.length, 4);
  const pending = adminRes.body.clients.find((row) => row._id === clients[3]._id);
  assert.equal(pending.leadSource, "influencer");
  assert.equal(pending.assignedSeller, null);
});

for (const [name, handler, successStatus, body] of [
  ["detalle", getClient, 200, {}],
  ["perfil", updateProfile, 200, { stage: "onboarding" }],
  ["agregar nota", addNote, 201, { text: "Primer contacto" }],
  ["borrar nota", deleteNote, 200, {}],
]) {
  test(`CRM ${name}: admite directos y asignados, rechaza ajenos, pendientes y cuentas admin`, async (t) => {
    mockClientLookup(t);
    let profileQueries = 0;
    t.mock.method(CrmProfile, "findOne", () => {
      profileQueries += 1;
      return { populate: async () => ({ stage: "lead", notes: [] }) };
    });
    t.mock.method(CrmProfile, "findOneAndUpdate", () => {
      profileQueries += 1;
      return { populate: async () => ({ stage: "lead", notes: [] }) };
    });
    t.mock.method(Menu, "find", () => ({ select: async () => [] }));
    t.mock.method(Item, "countDocuments", async () => 0);
    t.mock.method(Seller, "find", () => ({ select: async () => [seller, influencer] }));
    for (const [index, row] of clients.entries()) {
      const res = response();
      const before = profileQueries;
      await handler({ seller, params: { userID: row._id, noteID: "64f000000000000000000701" }, body }, res);
      assert.equal(res.statusCode, index < 2 ? successStatus : 404, row.username);
      assert.equal(profileQueries - before, index < 2 ? 1 : 0, "No debe consultar ni modificar CRM ajeno");
      if (name === "detalle" && index === 1) {
        assert.equal(res.body.user.leadSource, "influencer");
        assert.deepEqual(res.body.user.seller, influencer);
        assert.deepEqual(res.body.user.assignedSeller, seller);
      }
    }
  });
}

test("CRM overdue-count incluye seguimientos de directos y asignados, sin contar ajenos, y suma newAssignments desde la última vez visto", async (t) => {
  mockClientLookup(t);
  t.mock.method(CrmProfile, "countDocuments", async (filter) => {
    assert.deepEqual(filter.userID.$in, clients.slice(0, 2).map((row) => row._id));
    return filter.userID.$in.length;
  });
  const seenAt = new Date("2026-09-01T00:00:00.000Z");
  t.mock.method(Seller, "findById", (id) => {
    assert.equal(id, seller._id);
    return { select: async () => ({ crmAlertsSeenAt: seenAt }) };
  });
  t.mock.method(User, "countDocuments", async (filter) => {
    assert.deepEqual(filter, { assignedSeller: seller._id, assignedSellerAt: { $gt: seenAt } });
    return 3;
  });
  const res = response();
  await getOverdueCount({ seller }, res);
  assert.deepEqual(res.body, { count: 2, newAssignments: 3 });
});

test("CRM overdue-count para admin no calcula newAssignments (no tiene bandeja personal)", async (t) => {
  mockClientLookup(t);
  t.mock.method(CrmProfile, "countDocuments", async () => 5);
  t.mock.method(Seller, "findById", () => assert.fail("Un admin no debería consultar crmAlertsSeenAt"));
  t.mock.method(User, "countDocuments", () => assert.fail("Un admin no debería contar newAssignments"));
  const res = response();
  await getOverdueCount({ user: { admin: true } }, res);
  assert.deepEqual(res.body, { count: 5, newAssignments: 0 });
});

test("CRM alertas: un vendedor marca sus alertas como vistas; un admin no puede", async (t) => {
  const updatedAt = new Date("2026-09-15T12:30:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: updatedAt });
  t.mock.method(Seller, "findByIdAndUpdate", async (id, update) => {
    assert.equal(id, seller._id);
    assert.deepEqual(update, { crmAlertsSeenAt: updatedAt });
    return { ...seller, crmAlertsSeenAt: updatedAt };
  });
  const res = response();
  await markAlertsSeen({ seller }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });

  const forbidden = response();
  await markAlertsSeen({ user: { admin: true } }, forbidden);
  assert.equal(forbidden.statusCode, 403);
});

test("CRM asignación: solo admin asigna a un vendedor habilitado, conserva el influencer de origen y estampa assignedSellerAt", async (t) => {
  mockClientLookup(t);
  const assignmentInstant = new Date("2026-09-15T12:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: assignmentInstant });
  let saved;
  t.mock.method(Seller, "exists", async (filter) => {
    assert.deepEqual(filter, { _id: seller._id, active: true, influencer: { $ne: true }, receivesLeads: true });
    return { _id: seller._id };
  });
  t.mock.method(User, "updateOne", async (filter, update) => {
    assert.deepEqual(filter, { _id: clients[3]._id, admin: false, influencerReferral: true });
    saved = update;
    return { matchedCount: 1 };
  });
  t.mock.method(CrmProfile, "findOneAndUpdate", () => ({ populate: async () => ({ stage: "lead" }) }));
  const res = response();
  await updateProfile({ user: { admin: true }, params: { userID: clients[3]._id }, body: { assignedSeller: seller._id } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(saved, { $set: { assignedSeller: seller._id, assignedSellerAt: assignmentInstant } });
});

test("CRM asignación: admin puede dejar un referido pendiente sin cambiar el origen, y limpia assignedSellerAt", async (t) => {
  mockClientLookup(t);
  t.mock.method(Seller, "exists", () => assert.fail("Desasignar no requiere un vendedor"));
  t.mock.method(User, "updateOne", async (_filter, update) => {
    assert.deepEqual(update, { $set: { assignedSeller: null, assignedSellerAt: null } });
    return { matchedCount: 1 };
  });
  t.mock.method(CrmProfile, "findOneAndUpdate", () => ({ populate: async () => ({ stage: "lead" }) }));
  const res = response();
  await updateProfile({ user: { admin: true }, params: { userID: clients[1]._id }, body: { assignedSeller: null } }, res);
  assert.equal(res.statusCode, 200);
});

for (const [label, candidate] of [
  ["influencer", { active: true, influencer: true, receivesLeads: true }],
  ["inactivo", { active: false, influencer: false, receivesLeads: true }],
  ["sin recepción habilitada", { active: true, influencer: false, receivesLeads: false }],
  ["inexistente", null],
]) {
  test(`CRM asignación rechaza vendedor ${label} antes de guardar`, async (t) => {
    mockClientLookup(t);
    t.mock.method(Seller, "exists", async (filter) => (
      candidate && matches({ _id: seller._id, ...candidate }, filter) ? { _id: seller._id } : null
    ));
    t.mock.method(User, "updateOne", () => assert.fail("No debe asignar a un vendedor no habilitado"));
    t.mock.method(CrmProfile, "findOneAndUpdate", () => assert.fail("No debe guardar un request inválido"));
    const res = response();
    await updateProfile({ user: { admin: true }, params: { userID: clients[3]._id }, body: { assignedSeller: seller._id } }, res);
    assert.equal(res.statusCode, 400);
  });
}

test("CRM asignación rechaza cambios de vendedor, clientes directos, IDs inválidos y perfiles inválidos", async (t) => {
  mockClientLookup(t);
  t.mock.method(Seller, "exists", () => assert.fail("No debe consultar vendedor para requests inválidos"));
  t.mock.method(User, "updateOne", () => assert.fail("No debe modificar la asignación"));
  t.mock.method(CrmProfile, "findOneAndUpdate", () => assert.fail("No debe modificar el CRM"));
  for (const [actor, userID, body, status] of [
    [{ seller }, clients[1]._id, { assignedSeller: null }, 403],
    [{ user: { admin: true } }, clients[0]._id, { assignedSeller: seller._id }, 400],
    [{ user: { admin: true } }, clients[3]._id, { assignedSeller: "inválido" }, 400],
    [{ user: { admin: true } }, clients[3]._id, { assignedSeller: { $ne: null } }, 400],
    [{ user: { admin: true } }, clients[3]._id, { assignedSeller: seller._id, stage: "inexistente" }, 400],
  ]) {
    const res = response();
    await updateProfile({ ...actor, params: { userID }, body }, res);
    assert.equal(res.statusCode, status);
  }
});

test("CRM router bloquea al influencer autenticado en todos los endpoints antes de leer o escribir CRM", async (t) => {
  t.mock.method(jwt, "verify", () => ({ id: influencer._id, role: "seller" }));
  t.mock.method(Seller, "findById", () => ({
    select: async (fields) => {
      assert.match(fields, /\binfluencer\b/);
      return { ...influencer, active: true, influencer: true };
    },
  }));
  for (const method of ["find", "findOne", "exists", "updateOne"]) {
    t.mock.method(User, method, () => assert.fail("No debe consultar ni modificar clientes con un token de influencer"));
  }
  t.mock.method(CrmProfile, "countDocuments", () => assert.fail("No debe contar seguimientos para un influencer"));
  for (const [method, url] of [
    ["GET", "/clients"],
    ["GET", `/clients/${clients[1]._id}`],
    ["PATCH", `/clients/${clients[1]._id}`],
    ["POST", `/clients/${clients[1]._id}/notes`],
    ["DELETE", `/clients/${clients[1]._id}/notes/64f000000000000000000701`],
    ["GET", "/overdue-count"],
    ["GET", "/summary"],
    ["GET", "/export"],
  ]) {
    const res = response();
    await new Promise((resolve, reject) => {
      const json = res.json;
      res.json = function (body) { json.call(this, body); resolve(); return this; };
      crmRouter.handle({ method, url, headers: { authorization: "Bearer test-token" }, body: {} }, res, (err) => {
        reject(err || new Error(`La ruta ${method} ${url} no bloqueó al influencer`));
      });
    });
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.match(res.body.message, /influencer/);
  }
});
