const test = require("node:test");
const assert = require("node:assert/strict");

const ENV = {
  MP_ORDERS_CLIENT_ID: "app-123",
  MP_ORDERS_CLIENT_SECRET: "secret-abc",
  MP_ORDERS_REDIRECT_URI: "https://api.example.com/api/orders/payments/oauth/callback",
  MP_ORDERS_WEBHOOK_URL: "https://api.example.com/api/orders/payments/webhook",
  MP_ORDERS_WEBHOOK_SECRET: "whsec",
  ORDERS_CREDENTIALS_KEY: "k".repeat(40),
  FRONTEND_URL: "https://app.example.com/",
};

const withEnv = (t, overrides = {}) => {
  const env = { ...ENV, ...overrides };
  const previous = {};
  for (const name of Object.keys(ENV)) {
    previous[name] = process.env[name];
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  t.after(() => {
    for (const name of Object.keys(ENV)) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
};

const OWNER = { _id: "owner-1", slug: "mi-local", hasDelivery: true, hasTakeAway: true, contactInfo: { businessName: "Mi Local" } };
const SETTINGS = { owner_id: "owner-1", options: { onlineOrdering: true } };
const UUID = "5f0b2c1e-3a4d-4b6f-8c7d-9e0f1a2b3c4d";
const BODY = {
  serviceType: "delivery",
  customerName: "Ana",
  customerPhone: "1122334455",
  deliveryAddress: "Calle 123",
  clientRequestId: UUID,
  items: [{ itemId: "507f1f77bcf86cd799439011", quantity: 2, unitPrice: 1, total: 1 }],
};

// Carga checkoutService con db/sql y el catálogo de Mongo reemplazados.
const load = (t, { handler, priced } = {}) => {
  const sql = require("../src/orders/db/sql");
  const catalog = require("../src/orders/services/menuCatalog");
  const calls = [];
  t.mock.method(sql, "query", async (text, params) => {
    const clean = text.replace(/\s+/g, " ").trim();
    calls.push({ text: clean, params });
    return (handler && handler(clean, params)) || { rows: [], rowCount: 0 };
  });
  t.mock.method(catalog, "priceOrderLines", async () => priced ?? {
    total: 3000,
    lines: [{ itemId: "507f1f77bcf86cd799439011", title: "Pizza", option: "Grande", unitPrice: 1500, quantity: 2, notes: null, position: 0 }],
  });
  const paths = ["checkoutService", "connectionService"].map((n) => require.resolve(`../src/orders/payments/${n}`));
  paths.forEach((p) => { delete require.cache[p]; });
  t.after(() => paths.forEach((p) => { delete require.cache[p]; }));
  const checkout = require(paths[0]);
  const connections = require(paths[1]);
  const mpApi = require("../src/orders/payments/mpApi");
  return { checkout, connections, mpApi, calls };
};

const seller = { connectionId: 9, mpUserId: "777", liveMode: true, accessToken: "APP_USR-del-local" };

test("checkout: el local sin pago online habilitado rechaza", async (t) => {
  withEnv(t);
  const { checkout } = load(t);
  await assert.rejects(
    checkout.createCheckout({ owner: OWNER, settings: { options: {} }, body: BODY }),
    (e) => e.status === 403 && e.code === "ONLINE_ORDERING_OFF",
  );
});

test("checkout: modalidad que el local no ofrece se rechaza", async (t) => {
  withEnv(t);
  const { checkout } = load(t);
  await assert.rejects(
    checkout.createCheckout({ owner: { ...OWNER, hasDelivery: false }, settings: SETTINGS, body: BODY }),
    (e) => e.status === 400 && e.code === "SERVICE_NOT_OFFERED",
  );
});

test("checkout: mesa y barra no son modalidades de pago online", async (t) => {
  withEnv(t);
  const { checkout } = load(t);
  await assert.rejects(
    checkout.createCheckout({ owner: OWNER, settings: SETTINGS, body: { ...BODY, serviceType: "table", tableNumber: 3 } }),
    (e) => e.status === 400,
  );
});

test("checkout: exige nombre, teléfono y, en delivery, dirección", async (t) => {
  withEnv(t);
  const { checkout, connections } = load(t);
  t.mock.method(connections, "getAccessToken", async () => seller);
  for (const patch of [{ customerName: "" }, { customerPhone: undefined }, { deliveryAddress: "" }]) {
    await assert.rejects(
      checkout.createCheckout({ owner: OWNER, settings: SETTINGS, body: { ...BODY, ...patch } }),
      (e) => e.status === 400,
      JSON.stringify(patch),
    );
  }
});

test("checkout: sin variables del webhook no cobra", async (t) => {
  withEnv(t, { MP_ORDERS_WEBHOOK_SECRET: undefined });
  const { checkout } = load(t);
  t.mock.method(console, "error", () => {});
  await assert.rejects(
    checkout.createCheckout({ owner: OWNER, settings: SETTINGS, body: BODY }),
    (e) => e.status === 503 && e.code === "MP_NOT_CONFIGURED",
  );
});

test("checkout: importe y precios los pone el servidor, y se cobra con el token del local", async (t) => {
  withEnv(t);
  let inserted;
  const { checkout, connections, mpApi, calls } = load(t, {
    handler: (text, params) => {
      if (text.startsWith("INSERT INTO order_online_payments")) {
        inserted = params;
        return { rows: [{ id: 41, external_reference: params[4], status: "PENDING", amount: params[5], expires_at: params[6], checkout_url: null }] };
      }
      if (text.startsWith("UPDATE order_online_payments SET preference_id")) {
        return { rows: [{ id: 41, external_reference: inserted[4], status: "PENDING", amount: "3000.00", expires_at: inserted[6], checkout_url: params[2] }] };
      }
      return null;
    },
  });
  t.mock.method(connections, "getAccessToken", async () => seller);
  const create = t.mock.method(mpApi, "createPreference", async () => ({ id: "pref-1", initPoint: "https://mp.example/checkout/pref-1", sandboxInitPoint: null }));

  const result = await checkout.createCheckout({ owner: OWNER, settings: SETTINGS, body: BODY });

  // El importe guardado es el cotizado en el servidor, no lo que mandó el cliente.
  assert.equal(inserted[5], 3000);
  const draft = JSON.parse(inserted[3]);
  assert.equal(draft.total, 3000);
  assert.equal(draft.serviceType, "delivery");
  assert.equal(draft.lines[0].unitPrice, 1500);
  assert.equal(draft.customer.address, "Calle 123");

  assert.equal(create.mock.callCount(), 1);
  const [token, prefBody, idempotencyKey] = create.mock.calls[0].arguments;
  assert.equal(token, "APP_USR-del-local");
  assert.equal(prefBody.items[0].unit_price, 1500);
  assert.equal(prefBody.items[0].quantity, 2);
  assert.equal(prefBody.items[0].title, "Pizza (Grande)");
  assert.equal(prefBody.items.reduce((s, i) => s + i.unit_price * i.quantity, 0), 3000);
  assert.equal(prefBody.external_reference, inserted[4]);
  assert.match(inserted[4], /^[0-9a-f]{48}$/);
  assert.equal(prefBody.notification_url, ENV.MP_ORDERS_WEBHOOK_URL);
  assert.equal(prefBody.back_urls.success, `https://app.example.com/mi-local/menu?pago=${inserted[4]}`);
  assert.equal(prefBody.auto_return, "approved");
  assert.ok(!("marketplace_fee" in prefBody), "sin comisión de plataforma");
  assert.equal(idempotencyKey, "order-checkout-41");

  assert.equal(result.checkoutUrl, "https://mp.example/checkout/pref-1");
  assert.equal(result.total, 3000);
  assert.equal(result.ref, inserted[4]);
  assert.ok(!JSON.stringify(result).includes("APP_USR"));
  // Se registra antes de llamar a MP.
  const insertAt = calls.findIndex((c) => c.text.startsWith("INSERT INTO order_online_payments"));
  const updateAt = calls.findIndex((c) => c.text.startsWith("UPDATE order_online_payments SET preference_id"));
  assert.ok(insertAt >= 0 && insertAt < updateAt);
});

test("checkout: un reintento con el mismo clientRequestId no crea otra preferencia", async (t) => {
  withEnv(t);
  const row = { id: 41, external_reference: "a".repeat(48), status: "PENDING", amount: "3000.00", expires_at: new Date(), checkout_url: "https://mp.example/x" };
  const { checkout, connections, mpApi } = load(t, {
    handler: (text) => (text.startsWith("SELECT * FROM order_online_payments") ? { rows: [row] } : null),
  });
  const token = t.mock.method(connections, "getAccessToken", async () => seller);
  const create = t.mock.method(mpApi, "createPreference", async () => { throw new Error("no debería llamarse"); });
  const result = await checkout.createCheckout({ owner: OWNER, settings: SETTINGS, body: BODY });
  assert.equal(result.checkoutUrl, "https://mp.example/x");
  assert.equal(create.mock.callCount(), 0);
  assert.equal(token.mock.callCount(), 0);
});

test("checkout: un pago ya aprobado no devuelve link para pagar de nuevo", async (t) => {
  withEnv(t);
  const row = { id: 41, external_reference: "a".repeat(48), status: "APPROVED", amount: "3000.00", expires_at: new Date(), checkout_url: "https://mp.example/x" };
  const { checkout } = load(t, {
    handler: (text) => (text.startsWith("SELECT * FROM order_online_payments") ? { rows: [row] } : null),
  });
  const result = await checkout.createCheckout({ owner: OWNER, settings: SETTINGS, body: BODY });
  assert.equal(result.status, "APPROVED");
  assert.equal(result.checkoutUrl, null);
});

test("checkout: si MP falla, el intento se cierra y responde 502", async (t) => {
  withEnv(t);
  const { checkout, connections, mpApi, calls } = load(t, {
    handler: (text, params) => (text.startsWith("INSERT INTO order_online_payments")
      ? { rows: [{ id: 41, external_reference: params[4], status: "PENDING", amount: params[5], expires_at: params[6] }] }
      : null),
  });
  t.mock.method(connections, "getAccessToken", async () => seller);
  t.mock.method(mpApi, "createPreference", async () => { throw new mpApi.MpApiError(500, "internal"); });
  t.mock.method(console, "error", () => {});
  await assert.rejects(
    checkout.createCheckout({ owner: OWNER, settings: SETTINGS, body: BODY }),
    (e) => e.status === 502 && e.code === "MP_CHECKOUT_FAILED",
  );
  assert.ok(calls.some((c) => c.text.includes("SET status = 'REJECTED'")));
});

test("estado del checkout: referencia inválida o de otro local da 404", async (t) => {
  withEnv(t);
  const { checkout, calls } = load(t);
  await assert.rejects(checkout.getCheckoutStatus({ owner: OWNER, ref: "../etc" }), (e) => e.status === 404);
  assert.equal(calls.length, 0, "ni consulta la base con una ref mal formada");
  await assert.rejects(checkout.getCheckoutStatus({ owner: OWNER, ref: "b".repeat(48) }), (e) => e.status === 404);
  assert.equal(calls[0].params[0], "owner-1", "siempre acotado al local del slug");
});

test("estado del checkout: devuelve solo lo necesario para el cliente", async (t) => {
  withEnv(t);
  const { checkout } = load(t, {
    handler: () => ({
      rows: [{
        status: "APPROVED", expires_at: new Date(Date.now() + 1000), amount: "3000.00", order_number: 12, order_status: "pending",
        draft: { serviceType: "delivery", customer: { phone: "1122334455" } }, checkout_url: "https://mp.example/x", external_reference: "z",
      }],
    }),
  });
  const dto = await checkout.getCheckoutStatus({ owner: OWNER, ref: "c".repeat(48) });
  assert.deepEqual(dto, {
    status: "APPROVED", expired: false, total: 3000, serviceType: "delivery", orderNumber: 12, orderStatus: "pending",
    createdAt: null, confirmedAt: null, readyAt: null, dispatchedAt: null, deliveredAt: null, cancelledAt: null, refund: "none", estimate: null,
  });
});

test("configuración pública: deshabilitada si no hay cuenta de MP conectada", async (t) => {
  withEnv(t);
  const { checkout, connections } = load(t);
  const status = t.mock.method(connections, "getStatus", async () => ({ connected: false }));
  assert.deepEqual(await checkout.getOnlineConfig(OWNER, SETTINGS), { enabled: false, modes: [], hideWhatsapp: false, estimate: null });
  status.mock.mockImplementation(async () => ({ connected: true }));
  assert.deepEqual(await checkout.getOnlineConfig(OWNER, SETTINGS), { enabled: true, modes: ["takeaway", "delivery"], hideWhatsapp: false, estimate: null });
  assert.deepEqual(await checkout.getOnlineConfig({ ...OWNER, hasTakeAway: false }, SETTINGS), { enabled: true, modes: ["delivery"], hideWhatsapp: false, estimate: null });
  assert.deepEqual(await checkout.getOnlineConfig(OWNER, { options: {} }), { enabled: false, modes: [], hideWhatsapp: false, estimate: null });
});

test("configuración pública: ocultar WhatsApp solo vale si el pago online funciona", async (t) => {
  withEnv(t);
  const { checkout, connections } = load(t);
  const status = t.mock.method(connections, "getStatus", async () => ({ connected: true }));
  const hiding = { options: { onlineOrdering: true, hideWhatsappOrder: true } };
  assert.deepEqual(await checkout.getOnlineConfig(OWNER, hiding), { enabled: true, modes: ["takeaway", "delivery"], hideWhatsapp: true, estimate: null });
  // Sin cuenta conectada, sin modalidades o sin pago online activado: WhatsApp se queda.
  status.mock.mockImplementation(async () => ({ connected: false }));
  assert.equal((await checkout.getOnlineConfig(OWNER, hiding)).hideWhatsapp, false);
  status.mock.mockImplementation(async () => ({ connected: true }));
  assert.equal((await checkout.getOnlineConfig({ ...OWNER, hasDelivery: false, hasTakeAway: false }, hiding)).hideWhatsapp, false);
  assert.equal((await checkout.getOnlineConfig(OWNER, { options: { hideWhatsappOrder: true } })).hideWhatsapp, false);
});

test("tiempo estimado: se informa al cliente solo si el local cargó mínimo y máximo", async (t) => {
  withEnv(t);
  const { checkout, connections } = load(t);
  t.mock.method(connections, "getStatus", async () => ({ connected: true }));
  const withEta = { options: { onlineOrdering: true, prepMinMinutes: 10, prepMaxMinutes: 25 } };
  assert.deepEqual((await checkout.getOnlineConfig(OWNER, withEta)).estimate, { minMinutes: 10, maxMinutes: 25 });
  for (const options of [{}, { prepMinMinutes: 10 }, { prepMaxMinutes: 25 }, { prepMinMinutes: 30, prepMaxMinutes: 20 }]) {
    assert.equal((await checkout.getOnlineConfig(OWNER, { options: { onlineOrdering: true, ...options } })).estimate, null, JSON.stringify(options));
  }
});

test("seguimiento: el estado del pedido trae etapas, devolución y estimación", async (t) => {
  withEnv(t);
  const stamp = new Date("2026-10-09T20:00:00.000Z");
  const { checkout } = load(t, {
    handler: () => ({
      rows: [{
        status: "PARTIALLY_REFUNDED", expires_at: stamp, amount: "3000.00", order_number: 12, order_status: "confirmed",
        order_created_at: stamp, confirmed_at: stamp, ready_at: null, delivered_at: null, cancelled_at: null,
        draft: { serviceType: "takeaway", customer: { phone: "1122334455", address: "Calle 1" } }, checkout_url: "https://mp.example/x",
      }],
    }),
  });
  const settings = { options: { prepMinMinutes: 10, prepMaxMinutes: 25 } };
  const dto = await checkout.getCheckoutStatus({ owner: OWNER, settings, ref: "d".repeat(48) });
  assert.equal(dto.orderStatus, "confirmed");
  assert.equal(dto.confirmedAt, stamp);
  assert.equal(dto.refund, "partial");
  assert.deepEqual(dto.estimate, { minMinutes: 10, maxMinutes: 25 });
  // Nada de datos personales ni del link de pago en la respuesta pública.
  assert.ok(!JSON.stringify(dto).includes("1122334455"));
  assert.ok(!JSON.stringify(dto).includes("mp.example"));
  assert.ok(!JSON.stringify(dto).includes("Calle 1"));
});

test("seguimiento: 'en camino' solo si el delivery salió después de quedar listo", async (t) => {
  withEnv(t);
  const ready = new Date("2026-01-01T20:00:00.000Z");
  const row = (over) => ({
    status: "APPROVED", expires_at: ready, amount: "3000.00", order_number: 5, order_status: "ready", order_created_at: ready,
    confirmed_at: ready, ready_at: ready, delivered_at: null, cancelled_at: null, dispatched_at: null,
    draft: { serviceType: "delivery", customer: {} }, ...over,
  });
  let current = row({});
  const { checkout } = load(t, { handler: () => ({ rows: [current] }) });
  const ref = "e".repeat(48);
  assert.equal((await checkout.getCheckoutStatus({ owner: OWNER, ref })).dispatchedAt, null);
  current = row({ dispatched_at: "2026-01-01T20:10:00.000Z" });
  assert.equal((await checkout.getCheckoutStatus({ owner: OWNER, ref })).dispatchedAt, "2026-01-01T20:10:00.000Z");
  current = row({ dispatched_at: "2026-01-01T19:50:00.000Z" });
  assert.equal((await checkout.getCheckoutStatus({ owner: OWNER, ref })).dispatchedAt, null, "salida vieja, antes de volver a quedar listo");
  current = row({ order_status: "delivered", dispatched_at: "2026-01-01T20:10:00.000Z" });
  assert.equal((await checkout.getCheckoutStatus({ owner: OWNER, ref })).dispatchedAt, null);
});
