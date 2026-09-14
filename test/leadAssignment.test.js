const test = require("node:test");
const assert = require("node:assert/strict");
const Seller = require("../src/models/Seller");
const LeadAssignmentState = require("../src/models/LeadAssignmentState");
const { nextLeadSeller } = require("../src/services/leadAssignmentService");

const query = rows => ({ select() { return this; }, sort(sort) { assert.deepEqual(sort, { _id: 1 }); return this; }, async lean() { return rows; } });

test("el reparto usa turnos atómicos compartidos y orden estable, incluso con solicitudes simultáneas", async t => {
  t.mock.method(Seller, "find", filter => {
    assert.deepEqual(filter, { active: true, receivesLeads: true, influencer: { $ne: true } });
    return query([{ _id: "a" }, { _id: "b" }, { _id: "c" }]);
  });
  let sequence = 0;
  t.mock.method(LeadAssignmentState, "findOneAndUpdate", async (filter, update, options) => {
    assert.deepEqual(filter, { _id: "influencer-leads" });
    assert.deepEqual(update, { $inc: { sequence: 1 } });
    assert.equal(options.new, true);
    return { sequence: ++sequence };
  });
  assert.deepEqual(await Promise.all(Array.from({ length: 9 }, () => nextLeadSeller())), ["a", "b", "c", "a", "b", "c", "a", "b", "c"]);
});

test("sin receptores devuelve pendiente sin consumir un turno", async t => {
  t.mock.method(Seller, "find", () => query([]));
  t.mock.method(LeadAssignmentState, "findOneAndUpdate", () => assert.fail("no debe reservar turno"));
  assert.equal(await nextLeadSeller(), null);
});

test("reintenta la creación concurrente del contador y propaga fallos de infraestructura", async t => {
  t.mock.method(Seller, "find", () => query([{ _id: "a" }]));
  let calls = 0;
  t.mock.method(LeadAssignmentState, "findOneAndUpdate", async () => {
    if (!calls++) throw Object.assign(new Error("duplicate"), { code: 11000 });
    return { sequence: 2 };
  });
  assert.equal(await nextLeadSeller(), "a");
  assert.equal(calls, 2);
  t.mock.method(LeadAssignmentState, "findOneAndUpdate", async () => { throw new Error("offline"); });
  await assert.rejects(nextLeadSeller, /offline/);
});
