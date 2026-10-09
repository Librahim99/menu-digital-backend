const test = require("node:test");
const assert = require("node:assert/strict");

const KEY = "k".repeat(40);
const ENV = {
  MP_ORDERS_CLIENT_ID: "app-123",
  MP_ORDERS_CLIENT_SECRET: "secret-abc",
  MP_ORDERS_REDIRECT_URI: "https://api.example.com/api/orders/payments/oauth/callback",
  ORDERS_CREDENTIALS_KEY: KEY,
  FRONTEND_URL: "https://app.example.com/",
};

const withEnv = (t, env = ENV) => {
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

// Carga el servicio con db/sql reemplazado por un fake (el servicio desestructura
// query/withTransaction al requerirse, por eso se parchea antes).
const loadService = (t, handler) => {
  const sql = require("../src/orders/db/sql");
  const calls = [];
  const run = async (text, params) => {
    calls.push({ text: text.replace(/\s+/g, " ").trim(), params });
    return handler(text.replace(/\s+/g, " ").trim(), params) ?? { rows: [], rowCount: 0 };
  };
  t.mock.method(sql, "query", run);
  t.mock.method(sql, "withTransaction", async (fn) => fn({ query: run }));
  const servicePath = require.resolve("../src/orders/payments/connectionService");
  delete require.cache[servicePath];
  t.after(() => { delete require.cache[servicePath]; });
  return { service: require(servicePath), calls };
};

test("cifrado: ida y vuelta, formato iv.tag.dato y detecta manipulación", (t) => {
  withEnv(t);
  const { encryptSecret, decryptSecret } = require("../src/orders/payments/crypto");
  const packed = encryptSecret("APP_USR-token-secreto");
  assert.equal(packed.split(".").length, 3);
  assert.ok(!packed.includes("APP_USR"));
  assert.equal(decryptSecret(packed), "APP_USR-token-secreto");
  assert.notEqual(encryptSecret("APP_USR-token-secreto"), packed, "IV aleatorio");

  const [iv, tag, data] = packed.split(".");
  const tampered = [iv, tag, Buffer.from("otro-dato").toString("base64")].join(".");
  assert.throws(() => decryptSecret(tampered));
  assert.throws(() => decryptSecret("basura"));
});

test("cifrado: sin clave propia suficiente no cifra", (t) => {
  withEnv(t, { ...ENV, ORDERS_CREDENTIALS_KEY: "corta" });
  const { encryptSecret } = require("../src/orders/payments/crypto");
  assert.throws(() => encryptSecret("x"), /ORDERS_CREDENTIALS_KEY/);
});

test("config: informa qué falta sin exponer valores", (t) => {
  withEnv(t, { ...ENV, MP_ORDERS_CLIENT_SECRET: undefined });
  const { missingForOAuth } = require("../src/orders/payments/config");
  assert.deepEqual(missingForOAuth(), ["MP_ORDERS_CLIENT_SECRET"]);
});

test("startConnection: guarda solo el hash del state y arma la URL de MP", async (t) => {
  withEnv(t);
  const { service, calls } = loadService(t, () => ({ rows: [], rowCount: 1 }));
  const { url } = await service.startConnection("owner-1");
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://auth.mercadopago.com/authorization");
  assert.equal(parsed.searchParams.get("client_id"), "app-123");
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(parsed.searchParams.get("redirect_uri"), ENV.MP_ORDERS_REDIRECT_URI);
  const state = parsed.searchParams.get("state");
  assert.match(state, /^[0-9a-f]{64}$/);
  const insert = calls.find((c) => c.text.startsWith("INSERT INTO order_mp_oauth_states"));
  assert.ok(insert);
  assert.notEqual(insert.params[0], state, "el state no se guarda en claro");
  assert.equal(insert.params[1], "owner-1");
  assert.ok(!url.includes("secret-abc"), "el client_secret no viaja en la URL");
});

test("startConnection: sin configuración responde 503", async (t) => {
  withEnv(t, { ...ENV, MP_ORDERS_CLIENT_ID: undefined });
  const { service } = loadService(t, () => null);
  t.mock.method(console, "error", () => {});
  await assert.rejects(service.startConnection("o"), (e) => e.status === 503 && e.code === "MP_NOT_CONFIGURED");
});

test("completeConnection: state inválido o ya usado se rechaza sin llamar a MP", async (t) => {
  withEnv(t);
  const { service } = loadService(t, () => ({ rows: [], rowCount: 0 }));
  const mpApi = require("../src/orders/payments/mpApi");
  const exchange = t.mock.method(mpApi, "exchangeCode", async () => { throw new Error("no debería llamarse"); });
  await assert.rejects(
    service.completeConnection({ code: "TG-1", state: "x" }),
    (e) => e.status === 400 && e.code === "MP_OAUTH_STATE_INVALID",
  );
  assert.equal(exchange.mock.callCount(), 0);
});

test("completeConnection: guarda los tokens cifrados y reemplaza la conexión previa del local", async (t) => {
  withEnv(t);
  const { service, calls } = loadService(t, (text) => {
    if (text.startsWith("UPDATE order_mp_oauth_states")) return { rows: [{ owner_id: "owner-1" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const mpApi = require("../src/orders/payments/mpApi");
  t.mock.method(mpApi, "exchangeCode", async () => ({
    access_token: "APP_USR-acceso", refresh_token: "TG-refresh", user_id: 777, expires_in: 15552000, live_mode: true, scope: "offline_access read write",
  }));

  const result = await service.completeConnection({ code: "TG-1", state: "abc" });
  assert.deepEqual(result, { ownerId: "owner-1" });

  const insert = calls.find((c) => c.text.startsWith("INSERT INTO order_mp_connections"));
  assert.ok(insert);
  const [owner, mpUser, accessEnc, refreshEnc] = insert.params;
  assert.equal(owner, "owner-1");
  assert.equal(mpUser, "777");
  assert.ok(!accessEnc.includes("APP_USR") && !refreshEnc.includes("TG-refresh"));
  const { decryptSecret } = require("../src/orders/payments/crypto");
  assert.equal(decryptSecret(accessEnc), "APP_USR-acceso");
  assert.equal(decryptSecret(refreshEnc), "TG-refresh");
  assert.ok(calls.some((c) => c.text.startsWith("UPDATE order_mp_connections SET status = 'disconnected'")));
});

test("completeConnection: una cuenta de MP viva en otro local se rechaza", async (t) => {
  withEnv(t);
  const { service, calls } = loadService(t, (text) => {
    if (text.startsWith("UPDATE order_mp_oauth_states")) return { rows: [{ owner_id: "owner-1" }], rowCount: 1 };
    if (text.includes("WHERE mp_user_id = $1 AND owner_id <> $2")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const mpApi = require("../src/orders/payments/mpApi");
  t.mock.method(mpApi, "exchangeCode", async () => ({ access_token: "a", user_id: 9 }));
  await assert.rejects(
    service.completeConnection({ code: "c", state: "s" }),
    (e) => e.status === 409 && e.code === "MP_ACCOUNT_IN_USE",
  );
  assert.ok(!calls.some((c) => c.text.startsWith("INSERT INTO order_mp_connections")));
});

test("getStatus: nunca devuelve tokens", async (t) => {
  withEnv(t);
  const { service } = loadService(t, () => ({
    rows: [{
      status: "active", mp_user_id: "777", live_mode: true, connected_at: "2026-10-08", token_expires_at: "2027-04-06",
      last_error: null, access_token_enc: "SECRETO", refresh_token_enc: "SECRETO2",
    }],
  }));
  const dto = await service.getStatus("owner-1");
  assert.equal(dto.connected, true);
  assert.equal(dto.configured, true);
  assert.ok(!JSON.stringify(dto).includes("SECRETO"));
});

test("getAccessToken: sin conexión devuelve MP_NOT_CONNECTED", async (t) => {
  withEnv(t);
  const { service } = loadService(t, () => ({ rows: [] }));
  await assert.rejects(service.getAccessToken("o"), (e) => e.status === 409 && e.code === "MP_NOT_CONNECTED");
});

test("getAccessToken: token vigente se descifra sin renovar", async (t) => {
  withEnv(t);
  const { encryptSecret } = require("../src/orders/payments/crypto");
  const row = {
    id: 5, mp_user_id: "777", access_token_enc: encryptSecret("APP_USR-vigente"),
    refresh_token_enc: encryptSecret("TG-r"), token_expires_at: new Date(Date.now() + 100 * 86400000),
  };
  const { service } = loadService(t, () => ({ rows: [row] }));
  const mpApi = require("../src/orders/payments/mpApi");
  const refresh = t.mock.method(mpApi, "refreshAccessToken", async () => { throw new Error("no debería renovar"); });
  const result = await service.getAccessToken("o");
  assert.equal(result.accessToken, "APP_USR-vigente");
  assert.equal(refresh.mock.callCount(), 0);
});

test("getAccessToken: por vencer renueva y guarda el refresh token nuevo", async (t) => {
  withEnv(t);
  const { encryptSecret, decryptSecret } = require("../src/orders/payments/crypto");
  const row = {
    id: 5, mp_user_id: "777", access_token_enc: encryptSecret("viejo"),
    refresh_token_enc: encryptSecret("TG-viejo"), token_expires_at: new Date(Date.now() + 2 * 86400000),
  };
  const { service, calls } = loadService(t, () => ({ rows: [row] }));
  const mpApi = require("../src/orders/payments/mpApi");
  const refresh = t.mock.method(mpApi, "refreshAccessToken", async (rt) => {
    assert.equal(rt, "TG-viejo");
    return { access_token: "nuevo", refresh_token: "TG-nuevo", user_id: 777, expires_in: 15552000 };
  });
  const result = await service.getAccessToken("o");
  assert.equal(result.accessToken, "nuevo");
  assert.equal(refresh.mock.callCount(), 1);
  const update = calls.find((c) => c.text.startsWith("UPDATE order_mp_connections SET access_token_enc"));
  assert.equal(decryptSecret(update.params[1]), "nuevo");
  assert.equal(decryptSecret(update.params[2]), "TG-nuevo");
});

test("getAccessToken: refresh rechazado por MP marca la conexión revocada", async (t) => {
  withEnv(t);
  const { encryptSecret } = require("../src/orders/payments/crypto");
  const row = {
    id: 5, mp_user_id: "777", access_token_enc: encryptSecret("viejo"),
    refresh_token_enc: encryptSecret("TG-viejo"), token_expires_at: new Date(Date.now() + 86400000),
  };
  const { service, calls } = loadService(t, () => ({ rows: [row] }));
  const mpApi = require("../src/orders/payments/mpApi");
  t.mock.method(mpApi, "refreshAccessToken", async () => { throw new mpApi.MpApiError(400, "invalid_grant"); });
  await assert.rejects(service.getAccessToken("o"), (e) => e.status === 409 && e.code === "MP_NOT_CONNECTED");
  assert.ok(calls.some((c) => c.text.includes("SET status = 'revoked'")));
});

test("disconnect: borra los tokens y deja la baja lógica", async (t) => {
  withEnv(t);
  const { service, calls } = loadService(t, () => ({ rows: [], rowCount: 1 }));
  assert.deepEqual(await service.disconnect("owner-1"), { disconnected: true });
  const update = calls[0].text;
  assert.match(update, /status = 'disconnected'/);
  assert.match(update, /access_token_enc = ''/);
  assert.match(update, /refresh_token_enc = NULL/);
  assert.doesNotMatch(update, /DELETE/i);
});
