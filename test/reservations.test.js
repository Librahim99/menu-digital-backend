const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const db = require("../src/reservations/db/sql");
const service = require("../src/reservations/services/reservationService");
const { createHub } = require("../src/reservations/realtime");
const { ownerAction, customerAction } = require("../src/reservations/utils/transitions");
const {
  parsePhone, parsePartySize, parseDate, parseTime, assertBookable, buenosAiresNow, addDays, parseSettingsPatch,
} = require("../src/reservations/utils/validate");
const { ReservationsError } = require("../src/reservations/errors");

// Reservas: reglas de validación, máquina de estados, servicio (con la base
// simulada) y hub de WebSocket (con sockets de mentira). Nada de esto abre
// puertos ni conexiones.

const SETTINGS_ROW = {
  owner_id: "owner1",
  enabled: true,
  phone_mode: "optional",
  max_party_size: 10,
  max_days_ahead: 30,
  min_notice_minutes: 60,
};

const reservation = (overrides = {}) => ({
  id: "7",
  owner_id: "owner1",
  code: "ABCDEFGH",
  customer_name: "Ana",
  customer_phone: null,
  party_size: 4,
  reserve_date: "2026-10-12",
  reserve_time: "22:00",
  status: "pending",
  source: "web",
  table_label: null,
  alt_date: null,
  alt_time: null,
  message: null,
  notes: null,
  internal_notes: null,
  created_at: "2026-10-08T12:00:00.000Z",
  updated_at: "2026-10-08T12:00:00.000Z",
  ...overrides,
});

const rejects = async (fn, status, code) => {
  await assert.rejects(fn, (error) => {
    assert.ok(error instanceof ReservationsError, `esperaba ReservationsError, llegó ${error}`);
    assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    return true;
  });
};

// ── Validación ───────────────────────────────

test("parseDate / parseTime aceptan formatos reales y rechazan el resto", () => {
  assert.equal(parseDate("2026-02-28"), "2026-02-28");
  assert.throws(() => parseDate("2026-02-30"), ReservationsError);
  assert.throws(() => parseDate("12/10/2026"), ReservationsError);
  assert.equal(parseTime("22:30"), "22:30");
  assert.throws(() => parseTime("24:00"), ReservationsError);
  assert.throws(() => parseTime("9:00"), ReservationsError);
});

test("parsePartySize respeta el máximo del local", () => {
  assert.equal(parsePartySize("4", 10), 4);
  assert.equal(parsePartySize(10, 10), 10);
  assert.throws(() => parsePartySize(11, 10), /WhatsApp/);
  assert.throws(() => parsePartySize(0, 10), ReservationsError);
  assert.throws(() => parsePartySize("abc", 10), ReservationsError);
  assert.throws(() => parsePartySize(2.5, 10), ReservationsError);
});

test("parsePhone según el modo configurado", () => {
  assert.equal(parsePhone("+54 11 2345-6789", "optional"), "+54 11 2345-6789");
  assert.equal(parsePhone("", "optional"), null);
  assert.equal(parsePhone("11 2345 6789", "off"), null);
  assert.throws(() => parsePhone("", "required"), /teléfono/);
  assert.throws(() => parsePhone("hola", "optional"), ReservationsError);
  assert.throws(() => parsePhone("123", "optional"), ReservationsError);
});

test("assertBookable exige anticipación mínima y respeta el máximo de días", () => {
  const settings = { minNoticeMinutes: 60, maxDaysAhead: 30 };
  // 2026-10-08 12:00 hora argentina = 15:00 UTC.
  const now = new Date("2026-10-08T15:00:00.000Z");
  assert.deepEqual(buenosAiresNow(now), { date: "2026-10-08", time: "12:00" });

  assert.doesNotThrow(() => assertBookable("2026-10-08", "13:00", settings, now));
  assert.throws(() => assertBookable("2026-10-08", "12:30", settings, now), ReservationsError);
  assert.throws(() => assertBookable("2026-10-07", "22:00", settings, now), ReservationsError);
  assert.doesNotThrow(() => assertBookable(addDays("2026-10-08", 30), "20:00", settings, now));
  assert.throws(() => assertBookable(addDays("2026-10-08", 31), "20:00", settings, now), /30 días/);
});

test("buenosAiresNow usa la fecha argentina aunque en UTC ya sea otro día", () => {
  // 01:30 UTC del 9/10 = 22:30 del 8/10 en Buenos Aires.
  assert.deepEqual(buenosAiresNow(new Date("2026-10-09T01:30:00.000Z")), { date: "2026-10-08", time: "22:30" });
});

test("parseSettingsPatch valida cada campo", () => {
  assert.deepEqual(parseSettingsPatch({ enabled: true, phoneMode: "required", maxPartySize: "8" }), {
    enabled: true, phoneMode: "required", maxPartySize: 8,
  });
  assert.throws(() => parseSettingsPatch({ enabled: "yes" }), ReservationsError);
  assert.throws(() => parseSettingsPatch({ phoneMode: "always" }), ReservationsError);
  assert.throws(() => parseSettingsPatch({ maxPartySize: 0 }), ReservationsError);
  assert.throws(() => parseSettingsPatch(null), ReservationsError);
});

// ── Máquina de estados ───────────────────────

test("confirmar una pendiente asigna mesa y limpia alternativas", () => {
  const update = ownerAction(reservation(), "confirm", { tableLabel: "Mesa 4" });
  assert.equal(update.status, "confirmed");
  assert.equal(update.table_label, "Mesa 4");
  assert.equal(update.alt_time, null);
});

test("el flujo de la card: rechazar con 22:30 → el cliente acepta → vuelve a pendiente → se confirma", () => {
  const pending = reservation();

  const rejectedUpdate = ownerAction(pending, "reject", { altTime: "22:30", message: "Sin lugar a las 22" });
  assert.equal(rejectedUpdate.status, "rejected");
  assert.equal(rejectedUpdate.alt_time, "22:30");
  assert.equal(rejectedUpdate.alt_date, "2026-10-12");

  const rejected = reservation({ ...rejectedUpdate });
  const acceptedUpdate = customerAction(rejected, "accept_alternative");
  assert.equal(acceptedUpdate.status, "pending");
  assert.equal(acceptedUpdate.reserve_time, "22:30");
  assert.equal(acceptedUpdate.reserve_date, "2026-10-12");
  assert.equal(acceptedUpdate.alt_time, null);
  assert.equal(acceptedUpdate.message, null);

  const again = reservation({ ...acceptedUpdate });
  assert.equal(ownerAction(again, "confirm", { tableLabel: "7" }).status, "confirmed");
});

test("rechazar sin alternativa deja alt vacío y el cliente no puede aceptar nada", () => {
  const update = ownerAction(reservation(), "reject", { message: "Cerrado por evento" });
  assert.equal(update.alt_time, null);
  assert.equal(update.alt_date, null);
  assert.throws(() => customerAction(reservation({ ...update }), "accept_alternative"), (error) => error.code === "NO_ALTERNATIVE");
});

test("la alternativa no puede ser el mismo horario ni venir sin hora", () => {
  assert.throws(() => ownerAction(reservation(), "reject", { altTime: "22:00" }), /mismo/);
  assert.throws(() => ownerAction(reservation(), "reject", { altDate: "2026-10-13" }), /horario/);
  const otherDay = ownerAction(reservation(), "reject", { altDate: "2026-10-13", altTime: "22:00" });
  assert.equal(otherDay.alt_date, "2026-10-13");
});

test("transiciones inválidas devuelven 409", () => {
  assert.throws(() => ownerAction(reservation({ status: "cancelled" }), "confirm"), (e) => e.status === 409);
  assert.throws(() => ownerAction(reservation({ status: "pending" }), "complete"), (e) => e.status === 409);
  assert.throws(() => ownerAction(reservation(), "teletransportar"), (e) => e.status === 400);
  assert.throws(() => customerAction(reservation({ status: "completed" }), "cancel"), (e) => e.status === 409);
  assert.throws(() => customerAction(reservation({ status: "pending" }), "accept_alternative"), (e) => e.status === 409);
});

test("si el local cancela, el mensaje para el cliente es obligatorio", () => {
  for (const status of ["pending", "confirmed", "rejected"]) {
    assert.throws(() => ownerAction(reservation({ status }), "cancel", {}), (e) => e.status === 400 && e.code === "MESSAGE_REQUIRED");
    assert.throws(() => ownerAction(reservation({ status }), "cancel", { message: "   " }), (e) => e.code === "MESSAGE_REQUIRED");
  }
  const update = ownerAction(reservation(), "cancel", { message: "Cerramos por mantenimiento" });
  assert.equal(update.status, "cancelled");
  assert.equal(update.message, "Cerramos por mantenimiento");
});

test("al cancelar el cliente se limpia el mensaje anterior del local", () => {
  const update = customerAction(reservation({ status: "rejected", message: "Sin lugar", alt_time: "22:30", alt_date: "2026-10-12" }), "cancel");
  assert.equal(update.message, null);
  assert.equal(update.alt_time, null);
});

test("el cliente puede cancelar pendiente, confirmada o rechazada", () => {
  for (const status of ["pending", "confirmed", "rejected"]) {
    assert.equal(customerAction(reservation({ status }), "cancel").status, "cancelled");
  }
});

// ── Servicio (base simulada) ─────────────────

test("createFromWeb guarda una reserva pendiente y no expone datos del local", async (t) => {
  const calls = [];
  t.mock.method(db, "query", async (text, params) => {
    calls.push({ text, params });
    if (/count\(\*\)/.test(text)) return { rows: [{ total: 0 }] };
    if (/INSERT INTO reservations/.test(text)) {
      return { rows: [reservation({ code: params[1], customer_name: params[2], party_size: params[4], reserve_date: params[5], reserve_time: params[6] })] };
    }
    throw new Error(`consulta inesperada: ${text}`);
  });

  const now = new Date("2026-10-08T15:00:00.000Z");
  const row = await service.createFromWeb("owner1", SETTINGS_ROW, {
    name: "  Ana   Pérez ", phone: "", partySize: "4", date: "2026-10-12", time: "22:00", notes: "Cumple",
  }, now);

  const insert = calls.find((call) => /INSERT/.test(call.text));
  assert.equal(insert.params[0], "owner1");
  assert.match(insert.params[1], /^[A-HJKMNP-Z2-9]{8}$/); // código de 8 caracteres sin ambiguos
  assert.equal(insert.params[2], "Ana Pérez");
  assert.equal(insert.params[7], "pending");
  assert.equal(insert.params[8], "web");

  const dto = service.toCustomerDTO(row);
  assert.equal(dto.status, "pending");
  assert.match(dto.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal("phone" in dto, false);
  assert.equal("internalNotes" in dto, false);
});

test("createFromWeb rechaza si el local no habilitó reservas o la hora ya pasó", async (t) => {
  t.mock.method(db, "query", async () => ({ rows: [{ total: 0 }] }));
  const now = new Date("2026-10-08T15:00:00.000Z");
  const body = { name: "Ana", partySize: 2, date: "2026-10-12", time: "22:00" };

  await rejects(() => service.createFromWeb("owner1", { ...SETTINGS_ROW, enabled: false }, body, now), 403, "RESERVATIONS_OFF");
  await rejects(() => service.createFromWeb("owner1", SETTINGS_ROW, { ...body, date: "2026-10-08", time: "12:10" }, now), 400);
  await rejects(() => service.createFromWeb("owner1", SETTINGS_ROW, { ...body, name: " " }, now), 400);
  await rejects(() => service.createFromWeb("owner1", { ...SETTINGS_ROW, phone_mode: "required" }, body, now), 400);
});

test("createFromWeb frena cuando hay demasiadas reservas abiertas", async (t) => {
  t.mock.method(db, "query", async () => ({ rows: [{ total: 300 }] }));
  const now = new Date("2026-10-08T15:00:00.000Z");
  await rejects(
    () => service.createFromWeb("owner1", SETTINGS_ROW, { name: "Ana", partySize: 2, date: "2026-10-12", time: "22:00" }, now),
    429
  );
});

test("la mesa y la alternativa solo se muestran al cliente en el estado que corresponde", () => {
  const confirmed = service.toCustomerDTO(reservation({ status: "confirmed", table_label: "Mesa 4" }));
  assert.equal(confirmed.tableLabel, "Mesa 4");
  const pending = service.toCustomerDTO(reservation({ status: "pending", table_label: "Mesa 4", alt_time: "22:30" }));
  assert.equal(pending.tableLabel, null);
  assert.equal(pending.altTime, null);
  const rejected = service.toCustomerDTO(reservation({ status: "rejected", alt_date: "2026-10-12", alt_time: "22:30" }));
  assert.equal(rejected.altTime, "22:30");
});

test("runOwnerAction condiciona el UPDATE al estado leído (no pisa un cambio concurrente)", async (t) => {
  let updateParams;
  t.mock.method(db, "query", async (text, params) => {
    if (/^\s*SELECT/.test(text)) return { rows: [reservation()] };
    updateParams = params;
    return { rows: [] }; // alguien cambió el estado en el medio
  });
  await rejects(() => service.runOwnerAction("owner1", 7, "confirm", { tableLabel: "1" }), 409, "CONFLICT");
  assert.equal(updateParams[1], "pending");
});

test("runOwnerAction no toca reservas de otro local", async (t) => {
  t.mock.method(db, "query", async () => ({ rows: [] }));
  await rejects(() => service.runOwnerAction("otroLocal", 7, "confirm", {}), 404);
});

test("runCustomerAction con código inexistente o mal formado da 404", async (t) => {
  t.mock.method(db, "query", async () => ({ rows: [] }));
  await rejects(() => service.runCustomerAction("ABCD-EFGH", "cancel"), 404);
  await rejects(() => service.runCustomerAction("basura!", "cancel"), 404);
});

test("listForOwner pide desde la fecha dada, incluye lo abierto sin importar la fecha y avisa si se truncó", async (t) => {
  let call;
  let size = 501;
  t.mock.method(db, "query", async (text, params) => {
    call = { text, params };
    return { rows: Array.from({ length: size }, (_, index) => reservation({ id: String(index + 1) })) };
  });
  const result = await service.listForOwner("owner1", { from: "2026-08-09" });
  assert.deepEqual(call.params, ["owner1", "2026-08-09", 501]);
  assert.ok(call.text.includes("status IN ('pending', 'rejected')"));
  assert.equal(result.rows.length, 500);
  assert.equal(result.truncated, true);

  size = 1;
  const small = await service.listForOwner("owner1", { from: "2026-08-09" });
  assert.equal(small.rows.length, 1);
  assert.equal(small.truncated, false);
});

// ── Hub de WebSocket ─────────────────────────

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = null;
    this.readyState = 1;
  }

  send(raw) { this.sent.push(JSON.parse(raw)); }

  close(code) { this.closed = code; this.readyState = 3; this.emit("close"); }

  type(kind) { return this.sent.filter((message) => message.type === kind); }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const say = async (socket, message) => { socket.emit("message", JSON.stringify(message)); await tick(); };

const buildHub = () => createHub({
  authorizeOwner: async (token) => (token === "jwt-owner1" ? "owner1" : null),
  authorizeCode: async (code) => (code === "ABCD-EFGH"
    ? { code: "ABCDEFGH", reservation: { code: "ABCD-EFGH", status: "pending" } }
    : null),
});

test("hub: el cliente recibe la foto inicial y luego los cambios de SU reserva", async () => {
  const hub = buildHub();
  const mine = new FakeSocket();
  const other = new FakeSocket();
  hub.connect(mine);
  hub.connect(other);

  await say(mine, { type: "watch", code: "ABCD-EFGH" });
  assert.equal(mine.type("reservation")[0].reservation.status, "pending");

  hub.publish("owner1", "ABCDEFGH", { id: 1, status: "confirmed", phone: "x" }, { code: "ABCD-EFGH", status: "confirmed" });
  assert.equal(mine.type("reservation").at(-1).reservation.status, "confirmed");
  assert.equal("phone" in mine.type("reservation").at(-1).reservation, false); // recibe la versión del cliente
  assert.equal(other.sent.length, 0); // no se suscribió a nada
});

test("hub: el panel autenticado recibe las reservas de su local y no las de otros", async () => {
  const hub = buildHub();
  const panel = new FakeSocket();
  hub.connect(panel);
  await say(panel, { type: "auth", token: "jwt-owner1" });
  assert.equal(panel.type("ready")[0].role, "owner");

  hub.publish("owner1", "ABCDEFGH", { id: 1, phone: "11" }, { status: "pending" });
  hub.publish("owner2", "ZZZZZZZZ", { id: 2 }, { status: "pending" });
  const received = panel.type("reservation");
  assert.equal(received.length, 1);
  assert.equal(received[0].reservation.id, 1);
});

test("hub: token inválido cierra el socket y código inexistente da error sin suscribir", async () => {
  const hub = buildHub();
  const bad = new FakeSocket();
  hub.connect(bad);
  await say(bad, { type: "auth", token: "falso" });
  assert.equal(bad.closed, 1008);
  assert.equal(bad.type("error")[0].code, "AUTH");

  const guess = new FakeSocket();
  hub.connect(guess);
  await say(guess, { type: "watch", code: "AAAA-AAAA" });
  assert.equal(guess.type("error")[0].code, "NOT_FOUND");
  hub.publish("owner1", "AAAAAAAA", {}, { status: "x" });
  assert.equal(guess.type("reservation").length, 0);
});

test("hub: un socket cerrado se limpia y no recibe más avisos", async () => {
  const hub = buildHub();
  const socket = new FakeSocket();
  hub.connect(socket);
  await say(socket, { type: "watch", code: "ABCD-EFGH" });
  assert.deepEqual(hub.stats(), { owners: 0, codes: 1 });

  socket.close(1000);
  assert.deepEqual(hub.stats(), { owners: 0, codes: 0 });
  const before = socket.sent.length;
  hub.publish("owner1", "ABCDEFGH", {}, { status: "cancelled" });
  assert.equal(socket.sent.length, before);
});

test("hub: mensajes inválidos no rompen la conexión y hay tope de reservas en seguimiento", async () => {
  const hub = createHub({
    authorizeOwner: async () => null,
    authorizeCode: async (code) => ({ code, reservation: { code } }),
  });
  const socket = new FakeSocket();
  hub.connect(socket);

  socket.emit("message", "no es json");
  await tick();
  assert.equal(socket.type("error").length, 1);
  assert.equal(socket.closed, null);

  for (let index = 0; index < 5; index += 1) await say(socket, { type: "watch", code: `CODE${index}` });
  await say(socket, { type: "watch", code: "CODE9" });
  assert.match(socket.type("error").at(-1).message, /Demasiadas/);
});
