const test = require("node:test");
const assert = require("node:assert/strict");
const Seller = require("../src/models/Seller");
const User = require("../src/models/User");
const {
  getSellerMetrics,
  clientToDTO,
  getSellers,
  getSellerById,
} = require("../src/controllers/sellerController");

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

function sellerListQuery(sellers) {
  return {
    sort() {
      return {
        async lean() {
          return sellers;
        },
      };
    },
  };
}

test("getSellerMetrics resume vigencia, vencimientos, planes y actividad reciente", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const clients = [
    {
      active: true,
      menu: true,
      subscription: "basic",
      subscriptionExpiresAt: new Date("2026-09-11T12:00:00.000Z"),
      createdAt: new Date("2026-08-22T12:00:00.000Z"),
    },
    {
      active: false,
      menu: false,
      subscription: "pro",
      subscriptionExpiresAt: null,
      createdAt: new Date("2026-07-01T12:00:00.000Z"),
    },
    {
      active: true,
      menu: false,
      subscription: "basic",
      subscriptionExpiresAt: new Date("2026-08-31T12:00:00.000Z"),
      createdAt: new Date("2026-08-31T12:00:00.000Z"),
    },
    {
      active: false,
      menu: true,
      subscription: "free",
      subscriptionExpiresAt: null,
      createdAt: new Date("2026-08-02T12:00:00.000Z"),
    },
  ];

  assert.deepEqual(getSellerMetrics(clients, now), {
    clientsTotal: 4,
    activeAccounts: 2,
    paidCurrent: 2,
    newClients30d: 3,
    expiring30d: 1,
    expired: 1,
    withMenu: 2,
    plans: { basic: 1, pro: 1 },
    lastClientAt: clients[2].createdAt,
  });
});

test("clientToDTO limita los datos del cliente y calcula el plan efectivo", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const client = {
    _id: "64f000000000000000000101",
    username: "restaurante-prueba",
    slug: "restaurante-prueba",
    active: true,
    menu: true,
    subscription: "pro",
    subscriptionExpiresAt: new Date("2026-08-31T12:00:00.000Z"),
    createdAt: new Date("2026-08-01T12:00:00.000Z"),
    sellerID: "64f000000000000000000201",
    contactInfo: {
      businessName: "Restaurante Prueba",
      mail: "privado@example.com",
      number: 1112345678,
      address: "Calle privada 123",
    },
    password: "no-debe-salir",
  };

  const dto = clientToDTO(client, now);

  assert.deepEqual(dto, {
    _id: client._id,
    username: "restaurante-prueba",
    businessName: "Restaurante Prueba",
    slug: "restaurante-prueba",
    active: true,
    menu: true,
    subscription: "pro",
    effectiveSubscription: "free",
    subscriptionExpiresAt: client.subscriptionExpiresAt,
    createdAt: client.createdAt,
  });
  assert.equal(dto.contactInfo, undefined);
  assert.equal(dto.sellerID, undefined);
  assert.equal(dto.password, undefined);
  assert.equal(dto.mail, undefined);
  assert.equal(dto.number, undefined);
});

test("getSellers agrupa clientes por vendedor y limita la consulta a no administradores", async (t) => {
  const sellerA = {
    _id: "64f000000000000000000201",
    name: "Ana",
    dni: "11111111",
    code: "ANA-111",
  };
  const sellerB = {
    _id: "64f000000000000000000202",
    name: "Bruno",
    dni: "22222222",
    code: "BRU-222",
  };
  const clients = [
    {
      _id: "64f000000000000000000101",
      sellerID: sellerA._id,
      active: true,
      menu: true,
      subscription: "basic",
      subscriptionExpiresAt: new Date("2999-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      _id: "64f000000000000000000102",
      sellerID: sellerA._id,
      active: false,
      menu: false,
      subscription: "free",
      subscriptionExpiresAt: null,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    },
    {
      _id: "64f000000000000000000103",
      sellerID: sellerB._id,
      active: true,
      menu: false,
      subscription: "pro",
      subscriptionExpiresAt: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
  ];
  let sellerSort;
  let userFilter;
  let userProjection;
  let userSort;

  t.mock.method(Seller, "find", () => ({
    sort(sort) {
      sellerSort = sort;
      return {
        async lean() {
          return [sellerA, sellerB];
        },
      };
    },
  }));
  t.mock.method(User, "find", (filter) => {
    userFilter = filter;
    return {
      select(fields) {
        userProjection = fields;
        return this;
      },
      sort(sort) {
        userSort = sort;
        return this;
      },
      async lean() {
        return clients;
      },
    };
  });

  const res = response();
  await getSellers({}, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(sellerSort, { createdAt: -1 });
  assert.deepEqual(userFilter, {
    admin: false,
    sellerID: { $in: [sellerA._id, sellerB._id] },
  });
  assert.match(userProjection, /sellerID/);
  assert.doesNotMatch(userProjection, /contactInfo\.mail/);
  assert.deepEqual(userSort, { createdAt: -1 });
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].metrics.clientsTotal, 2);
  assert.equal(res.body[0].metrics.paidCurrent, 1);
  assert.deepEqual(res.body[0].metrics.plans, { basic: 1, pro: 0 });
  assert.equal(res.body[1].metrics.clientsTotal, 1);
  assert.equal(res.body[1].metrics.paidCurrent, 1);
  assert.deepEqual(res.body[1].metrics.plans, { basic: 0, pro: 1 });
});

test("getSellers no consulta usuarios cuando no existen vendedores", async (t) => {
  t.mock.method(Seller, "find", () => sellerListQuery([]));
  t.mock.method(User, "find", () => {
    throw new Error("No debe consultar User para una lista vacía");
  });

  const res = response();
  await getSellers({}, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, []);
});

test("getSellerById responde 404 sin consultar clientes", async (t) => {
  t.mock.method(Seller, "findById", () => ({ lean: async () => null }));
  t.mock.method(User, "find", () => {
    throw new Error("No debe consultar User para un vendedor inexistente");
  });

  const res = response();
  await getSellerById(
    { params: { id: "64f000000000000000000299" } },
    res,
  );

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "Vendedor no encontrado" });
});

test("getSellers responde un mensaje genérico ante errores internos", async (t) => {
  const internalMessage = "MongoDB sellers collection is unavailable";
  t.mock.method(Seller, "find", () => {
    throw new Error(internalMessage);
  });
  t.mock.method(console, "error", () => {});

  const res = response();
  await getSellers({}, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    message: "Ocurrió un error interno. Intentá de nuevo.",
  });
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(internalMessage));
});
