const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const Seller = require("../src/models/Seller");
const SellerSale = require("../src/models/SellerSale");
const { getInfluencerOverview, netInfluencerCommission } = require("../src/services/influencerPanelService");
const { getMyInfluencerOverview } = require("../src/controllers/sellerPanelController");
const { createSeller, updateSeller } = require("../src/controllers/sellerController");
const { protectSeller, denyInfluencer } = require("../src/middleware/auth");
const { generateAuthToken } = require("../src/utils/authToken");

const response = () => ({ statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } });
const query = rows => ({ select() { return this; }, sort() { return this; }, async lean() { return rows; } });

test("el panel filtra por identidad autenticada y expone solo leads y comisiones propias", async t => {
  t.mock.method(User, "find", filter => {
    assert.deepEqual(filter, { sellerID: "influencer-a", influencerReferral: true, admin: false });
    return query([
      { _id: "lead-a", username: "bar", contactInfo: { businessName: "Bar", mail: "privado@example.com" }, createdAt: new Date(0) },
      { _id: "lead-b", username: "cafe", createdAt: new Date(0) },
    ]);
  });
  t.mock.method(SellerSale, "find", filter => {
    assert.deepEqual(filter, { influencerID: "influencer-a" });
    return query([
      { userID: "lead-a", subscriptionDate: new Date(1000), amount: 10000, influencerRate: 0.15, influencerCommissionAmount: 1500, refundedAmount: 2000, paymentStatus: "approved" },
      { userID: "lead-a", subscriptionDate: new Date(2000), amount: 10000, influencerRate: 0.15, influencerCommissionAmount: 0 },
    ]);
  });
  const result = await getInfluencerOverview({ _id: "influencer-a", name: "Ana", code: "ANA-001" });
  assert.deepEqual(result.totals, { leads: 2, conversions: 1, commission: 1200 });
  assert.equal(result.leads[0].status, "converted");
  assert.equal(result.leads[0].convertedAt.getTime(), 1000);
  assert.equal(result.leads[1].status, "pending");
  assert.doesNotMatch(JSON.stringify(result), /privado|refundedAmount|influencerID/);
});

test("la comisión neta respeta reembolsos, contracargos y renovaciones sin comisión", () => {
  const sale = { amount: 12345.67, influencerRate: 0.15, influencerCommissionAmount: 1851.85 };
  assert.equal(netInfluencerCommission(sale), 1851.85);
  assert.equal(netInfluencerCommission({ ...sale, refundedAmount: sale.amount }), 0);
  assert.equal(netInfluencerCommission({ ...sale, paymentStatus: "charged_back" }), 0);
  assert.equal(netInfluencerCommission({ ...sale, paymentStatus: "refunded" }), 0);
  assert.equal(netInfluencerCommission({ ...sale, influencerCommissionAmount: 0, refundedAmount: 500 }), 0);
});

test("el panel rechaza un vendedor normal aunque pida el ID de un influencer", async () => {
  const res = response();
  await getMyInfluencerOverview({ seller: { _id: "normal", influencer: false }, query: { sellerID: "influencer" } }, res);
  assert.equal(res.statusCode, 403);
});

test("el permiso del influencer se consulta en base y bloquea acceso general aunque Seller.admin=true", async t => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "jwt-prueba";
  t.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  t.mock.method(Seller, "findById", () => ({ select: async fields => {
    assert.match(fields, /\binfluencer\b/);
    return { active: true, influencer: true, admin: true };
  } }));
  const req = { headers: { authorization: `Bearer ${generateAuthToken("64f000000000000000000001", "seller")}` } };
  let authenticated = false;
  await protectSeller(req, response(), () => { authenticated = true; });
  assert.equal(authenticated, true);
  const res = response();
  denyInfluencer(req, res, () => assert.fail("no debe permitir CRM/overview general"));
  assert.equal(res.statusCode, 403);
});

test("el ABM rechaza flags inválidos e influencer receptor sin escribir", async t => {
  t.mock.method(Seller, "create", () => assert.fail("no debe crear"));
  for (const body of [{ influencer: "true" }, { receivesLeads: 1 }, { influencer: true, receivesLeads: true }]) {
    const res = response();
    await createSeller({ body }, res);
    assert.equal(res.statusCode, 400);
  }
  t.mock.method(Seller, "findById", async () => ({ influencer: false, receivesLeads: true, save() { assert.fail("no debe guardar"); } }));
  const res = response();
  await updateSeller({ body: { influencer: true }, params: { id: "a" } }, res);
  assert.equal(res.statusCode, 400);
});

test("User conserva el origen histórico y Seller rechaza una combinación contradictoria", async () => {
  assert.equal(User.schema.path("influencerReferral").options.immutable, true);
  const seller = new Seller({ name: "Ana", code: "ANA-001", mail: "ana@example.com", dni: "123", password: "password-seguro", influencer: true, receivesLeads: true });
  await assert.rejects(seller.validate(), /no puede recibir leads/);
});
