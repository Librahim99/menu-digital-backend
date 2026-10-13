const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { startOrdersDb, fakeCatalog, stubModule } = require("../test-support/ordersDb");

// Endpoints de caja de punta a punta: rutas reales de /api/orders sobre un
// servidor HTTP, con SQL de verdad en memoria. Lo único de mentira es lo que
// viene de Mongo (el local y el JWT del panel).

const OWNERS = [];

let db;
let server;
let base;
let seq = 0;

test.before(async () => {
  db = await startOrdersDb(null, { catalog: fakeCatalog({ owners: OWNERS }) });
  stubModule(path.join(__dirname, "..", "src", "middleware", "auth.js"), {
    protect: (req, res, next) => {
      const owner = OWNERS.find((o) => o._id === req.headers["x-test-owner"]);
      if (!owner) return res.status(401).json({ message: "No autorizado" });
      req.user = { ...owner, subscription: "pro" };
      next();
    },
  });
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use("/api/orders", db.load("routes"));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/orders`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});

const venue = () => {
  seq += 1;
  const owner = { _id: `owner-cash-http-${seq}`, slug: `caja-http-${seq}`, active: true };
  OWNERS.push(owner);
  return { "x-test-owner": owner._id };
};

const call = async (method, url, { body, headers = {} } = {}) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

test("caja por HTTP: abrir, mover plata, ver el libro, cerrar y filtrar el historial", async () => {
  const headers = venue();
  assert.equal((await call("GET", "/cash/overview")).status, 401);

  let res = await call("GET", "/cash/overview", { headers });
  assert.equal(res.status, 200);
  assert.equal(res.body.registers.length, 1);
  assert.deepEqual(res.body.sessions, []);
  assert.equal(res.body.movementTypes.length, 3);

  res = await call("POST", "/cash/sessions", { headers, body: { cashierName: "Ana", openingAmount: 1000 } });
  assert.equal(res.status, 201);
  const id = res.body.session.id;
  assert.equal(res.body.session.openedByName, "Panel");

  res = await call("POST", `/cash/sessions/${id}/movements`, { headers, body: { type: "expense", category: "supplier", amount: 400 } });
  assert.equal(res.status, 201);
  assert.equal(res.body.session.summary.expectedCash, 600);
  assert.equal((await call("POST", `/cash/sessions/${id}/movements`, { headers, body: { type: "expense", amount: -5 } })).status, 400);

  res = await call("GET", `/cash/sessions/${id}/ledger?type=expense&cashOnly=1`, { headers });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.totals.out, 400);
  const movementId = res.body.entries[0].movementId;
  assert.equal((await call("GET", `/cash/sessions/${id}/ledger?type=nope`, { headers })).status, 400);

  res = await call("POST", `/cash/movements/${movementId}/void`, { headers, body: { reason: "Error" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.session.summary.expectedCash, 1000);

  assert.equal((await call("POST", `/cash/sessions/${id}/close`, { headers, body: {} })).status, 400);
  res = await call("POST", `/cash/sessions/${id}/close`, { headers, body: { cashCounted: 900, cashWithdrawn: 400 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.session.difference, -100);
  assert.equal(res.body.session.cashLeft, 500);

  res = await call("GET", "/cash/sessions?result=short&cashier=Ana&register=" + res.body.session.registerId, { headers });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.totals.shortAmount, -100);
  assert.equal((await call("GET", "/cash/sessions?result=over", { headers })).body.total, 0);
  assert.equal((await call("GET", "/cash/sessions?from=ayer", { headers })).status, 400);
  assert.equal((await call("GET", "/cash/sessions?result=nope", { headers })).status, 400);

  // Otro local no ve ni toca esta caja.
  const other = venue();
  assert.equal((await call("GET", `/cash/sessions/${id}/ledger`, { headers: other })).status, 404);
  assert.equal((await call("POST", `/cash/movements/${movementId}/void`, { headers: other, body: {} })).status, 404);
});
