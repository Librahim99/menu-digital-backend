const test = require("node:test");
const assert = require("node:assert/strict");
const Seller = require("../src/models/Seller");
const User = require("../src/models/User");
const {
  getSellers,
  getSellerById,
} = require("../src/controllers/sellerController");
const { protectSellerOrAdmin } = require("../src/middleware/auth");
const { generateAuthToken } = require("../src/utils/authToken");

function response() {
  return {
    statusCode: 200,
    body: null,
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

// Encadena .select()/.sort()/.lean() como lo hace el controller, capturando
// cada argumento para poder chequear la proyección real que se le pide a Mongo.
function sellerFindQuery(sellers, calls) {
  return {
    select(fields) {
      calls.select = fields;
      return this;
    },
    sort(sort) {
      calls.sort = sort;
      return this;
    },
    async lean() {
      return sellers;
    },
  };
}

function sellerFindByIdQuery(seller, calls) {
  return {
    select(fields) {
      calls.select = fields;
      return this;
    },
    async lean() {
      return seller;
    },
  };
}

test("getSellers proyecta solo los campos del ABM y no consulta clientes ni facturación", async (t) => {
  const sellerA = {
    _id: "64f000000000000000000201",
    name: "Ana",
    dni: "11111111",
    code: "ANA-111",
    mail: "ana@example.com",
    number: null,
    active: true,
    admin: false,
    startDate: null,
    profilePicture: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const calls = {};
  // Si el controller todavía consultara clientes o facturación para armar un
  // resumen que el ABM ya no muestra, cualquiera de estos dos mocks explota.
  t.mock.method(User, "find", () => {
    throw new Error("getSellers no debe consultar User");
  });
  t.mock.method(Seller, "find", (filter) => {
    calls.filter = filter;
    return sellerFindQuery([sellerA], calls);
  });

  const res = response();
  await getSellers({ query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.filter, { active: true });
  assert.match(calls.select, /\bname\b/);
  assert.doesNotMatch(calls.select, /password/);
  assert.deepEqual(calls.sort, { createdAt: -1 });
  assert.deepEqual(res.body, [{
    _id: sellerA._id,
    name: sellerA.name,
    mail: sellerA.mail,
    number: sellerA.number,
    startDate: sellerA.startDate,
    dni: sellerA.dni,
    code: sellerA.code,
    active: sellerA.active,
    admin: sellerA.admin,
    profilePicture: sellerA.profilePicture,
    createdAt: sellerA.createdAt,
    updatedAt: sellerA.updatedAt,
  }]);
});

test("getSellers incluye a los dados de baja solo cuando se pide explícitamente", async (t) => {
  const calls = {};
  t.mock.method(Seller, "find", (filter) => {
    calls.filter = filter;
    return sellerFindQuery([], calls);
  });

  const res = response();
  await getSellers({ query: { includeInactive: "true" } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.filter, {});
  assert.deepEqual(res.body, []);
});

test("getSellerById responde 404 sin exponer el documento", async (t) => {
  t.mock.method(Seller, "findById", () => sellerFindByIdQuery(null, {}));

  const res = response();
  await getSellerById({ params: { id: "64f000000000000000000299" } }, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "Vendedor no encontrado" });
});

test("getSellerById devuelve el DTO del vendedor sin métricas ni clientes", async (t) => {
  const seller = {
    _id: "64f000000000000000000301",
    name: "Bruno",
    dni: "22222222",
    code: "BRU-222",
    mail: "bruno@example.com",
    number: 1112345678,
    active: true,
    admin: false,
    startDate: null,
    profilePicture: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const calls = {};
  t.mock.method(Seller, "findById", () => sellerFindByIdQuery(seller, calls));

  const res = response();
  await getSellerById({ params: { id: seller._id } }, res);

  assert.equal(res.statusCode, 200);
  assert.match(calls.select, /\bname\b/);
  assert.deepEqual(res.body, {
    _id: seller._id,
    name: seller.name,
    mail: seller.mail,
    number: seller.number,
    startDate: seller.startDate,
    dni: seller.dni,
    code: seller.code,
    active: seller.active,
    admin: seller.admin,
    profilePicture: seller.profilePicture,
    createdAt: seller.createdAt,
    updatedAt: seller.updatedAt,
  });
  assert.equal(res.body.metrics, undefined);
  assert.equal(res.body.clients, undefined);
});

test("getSellers responde un mensaje genérico ante errores internos", async (t) => {
  const internalMessage = "MongoDB sellers collection is unavailable";
  t.mock.method(Seller, "find", () => {
    throw new Error(internalMessage);
  });
  t.mock.method(console, "error", () => {});

  const res = response();
  await getSellers({ query: {} }, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    message: "Ocurrió un error interno. Intentá de nuevo.",
  });
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(internalMessage));
});

// ──────────────────────────────────────────────
// protectSellerOrAdmin (middleware/auth.js) — única puerta de entrada de un
// login de vendedor: solo GET /api/sellers/:id la usa, y solo para su propio
// id. El resto de la app sigue resolviendo exclusivamente contra User.
// ──────────────────────────────────────────────

function withJwtSecret(t) {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "jwt-secret-de-prueba";
  t.after(() => {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  });
}

test("protectSellerOrAdmin deja pasar a un admin y bloquea a un User que no lo es", async (t) => {
  withJwtSecret(t);

  const admin = { _id: "64f000000000000000000201", admin: true };
  t.mock.method(User, "findById", () => ({ select: async () => admin }));

  const adminReq = {
    headers: { authorization: `Bearer ${generateAuthToken(admin._id)}` },
    params: { id: "64f000000000000000000299" },
  };
  let nextCalled = false;
  await protectSellerOrAdmin(adminReq, response(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(adminReq.user, admin);

  const plainUser = { _id: "64f000000000000000000202", admin: false };
  t.mock.method(User, "findById", () => ({ select: async () => plainUser }));

  const userReq = {
    headers: { authorization: `Bearer ${generateAuthToken(plainUser._id)}` },
    params: { id: "64f000000000000000000299" },
  };
  const userRes = response();
  await protectSellerOrAdmin(userReq, userRes, () => assert.fail("no debe dejar pasar a un User no admin"));
  assert.equal(userRes.statusCode, 403);
});

test("protectSellerOrAdmin deja a un vendedor ver su propio registro", async (t) => {
  withJwtSecret(t);

  const seller = { _id: "64f000000000000000000301", active: true };
  t.mock.method(Seller, "findById", () => ({ select: async () => seller }));

  const req = {
    headers: { authorization: `Bearer ${generateAuthToken(seller._id, "seller")}` },
    params: { id: seller._id },
  };
  let nextCalled = false;
  await protectSellerOrAdmin(req, response(), () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.seller, seller);
});

test("protectSellerOrAdmin bloquea a un vendedor que pide el registro de otro, sin consultar la base", async (t) => {
  withJwtSecret(t);

  t.mock.method(Seller, "findById", () => {
    throw new Error("no debe consultar el registro de otro vendedor");
  });

  const req = {
    headers: { authorization: `Bearer ${generateAuthToken("64f000000000000000000301", "seller")}` },
    params: { id: "64f000000000000000000999" },
  };
  const res = response();
  await protectSellerOrAdmin(req, res, () => assert.fail("no debe dejar ver el registro de otro vendedor"));

  assert.equal(res.statusCode, 403);
});

test("protectSellerOrAdmin bloquea a un vendedor desactivado", async (t) => {
  withJwtSecret(t);

  const inactiveSeller = { _id: "64f000000000000000000302", active: false };
  t.mock.method(Seller, "findById", () => ({ select: async () => inactiveSeller }));

  const req = {
    headers: { authorization: `Bearer ${generateAuthToken(inactiveSeller._id, "seller")}` },
    params: { id: inactiveSeller._id },
  };
  const res = response();
  await protectSellerOrAdmin(req, res, () => assert.fail("no debe dejar pasar a un vendedor desactivado"));

  assert.equal(res.statusCode, 403);
});

test("protectSellerOrAdmin exige un token y lo valida", async (t) => {
  withJwtSecret(t);

  const noTokenRes = response();
  await protectSellerOrAdmin({ headers: {}, params: {} }, noTokenRes, () => assert.fail("no debe dejar pasar sin token"));
  assert.equal(noTokenRes.statusCode, 401);

  const badTokenRes = response();
  await protectSellerOrAdmin(
    { headers: { authorization: "Bearer no-es-un-jwt-valido" }, params: {} },
    badTokenRes,
    () => assert.fail("no debe dejar pasar con un token inválido"),
  );
  assert.equal(badTokenRes.statusCode, 401);
});
