// Cuenta de una mesa: comensales, reparto de productos, modo de división y
// pagos parciales registrados a mano por el personal.
//
// - La cuenta es de la sesión de mesa (table_sessions): junta todos sus
//   pedidos, hayan salido de un celular, de varios o del operador.
// - Los importes no se guardan: se calculan cada vez desde los pedidos
//   (billMath), así agregar un pedido o quitar un producto actualiza la cuenta
//   sola y los totales no se desfasan.
// - Modos: 'items' (cada uno paga lo que tiene asignado; un producto puede ir
//   entero a uno o fraccionado entre varios), 'equal' (partes iguales) y
//   'custom' (importe a mano por comensal).
// - Los pagos no se cobran desde acá: el personal anota que cobró, con qué
//   medio y quién pagó. Se anulan, nunca se borran.
// - Cada cambio queda en bill_events (quién y cuándo).
// - La maneja el operador a cargo de la mesa (o cualquiera si todavía no la
//   tomó nadie) y el panel. Con la mesa cerrada queda de solo lectura.

const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { NOT_BILLED_STATUSES, LIMITS, PAYMENT_KINDS } = require("../constants");
const { cleanText, positiveInt, positiveMoney, optionalMoney, optionalUuid } = require("../utils/validate");
const { getSessionRow, assertWaiterCanManage } = require("./tableSessionService");
const { lockOrOpenCashSession } = require("./cashService");
const { computeBill, SPLIT_MODES, toCents } = require("./billMath");
const realtime = require("../delivery/realtime");

const num = (value) => (value === null || value === undefined ? null : Number(value));
const optionalId = (value) => (value === null || value === undefined ? null : Number(value));

const toPaymentDTO = (row) => ({
  id: Number(row.id),
  amount: num(row.amount),
  methodKind: row.method_kind,
  methodName: row.method_name,
  guestId: optionalId(row.guest_id),
  payerName: row.payer_name ?? null,
  reference: row.reference ?? null,
  status: row.status,
  actorType: row.actor_type ?? null,
  actorName: row.actor_name ?? row.waiter_name ?? null,
  createdAt: row.created_at,
  voidedAt: row.voided_at,
  voidReason: row.void_reason ?? null,
});

const toEventDTO = (row) => ({
  id: Number(row.id),
  type: row.event_type,
  detail: row.detail ?? {},
  actorType: row.actor_type,
  actorName: row.actor_name ?? null,
  createdAt: row.created_at,
});

const recordEvent = (client, session, type, detail, actor) =>
  client.query(
    `INSERT INTO bill_events (owner_id, table_session_id, event_type, detail, actor_type, actor_id, actor_name)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [session.owner_id, session.id, type, JSON.stringify(detail ?? {}), actor?.type ?? "system",
      actor?.id == null ? null : String(actor.id), actor?.name ?? null]
  );

const activeGuests = async (runner, sessionId) => {
  const { rows } = await runner.query(
    "SELECT * FROM bill_guests WHERE table_session_id = $1 AND removed_at IS NULL ORDER BY position, id",
    [sessionId]
  );
  return rows;
};

// La cuenta completa de una sesión de mesa ya leída.
const loadBill = async (runner, session) => {
  const { rows: orders } = await runner.query(
    "SELECT id, number, total FROM orders WHERE table_session_id = $1 AND NOT (status = ANY($2)) ORDER BY created_at, id",
    [session.id, NOT_BILLED_STATUSES]
  );
  const { rows: lines } = orders.length === 0 ? { rows: [] } : await runner.query(
    `SELECT id, order_id, title, option_name, quantity, unit_price, author_name, shared FROM order_items
     WHERE order_id = ANY($1) AND status <> 'cancelled' ORDER BY order_id, position, id`,
    [orders.map((order) => order.id)]
  );
  const guests = await activeGuests(runner, session.id);
  const { rows: shares } = await runner.query(
    "SELECT order_item_id, guest_id, weight FROM bill_item_shares WHERE table_session_id = $1",
    [session.id]
  );
  const { rows: payments } = await runner.query(
    "SELECT * FROM payments WHERE table_session_id = $1 ORDER BY created_at DESC, id DESC",
    [session.id]
  );
  const { rows: events } = await runner.query(
    "SELECT * FROM bill_events WHERE table_session_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
    [session.id, LIMITS.billEventsShown]
  );

  const linesByOrder = new Map();
  for (const line of lines) {
    const key = String(line.order_id);
    if (!linesByOrder.has(key)) linesByOrder.set(key, []);
    linesByOrder.get(key).push({
      id: line.id, title: line.title, option: line.option_name, quantity: line.quantity, unitPrice: line.unit_price,
      authorName: line.author_name, shared: line.shared,
    });
  }

  return {
    tableSessionId: Number(session.id),
    tableNumber: session.table_number,
    closed: Boolean(session.closed_at),
    ...computeBill({
      mode: session.split_mode ?? "none",
      orders: orders.map((order) => ({
        id: order.id, number: order.number, total: order.total, lines: linesByOrder.get(String(order.id)) ?? [],
      })),
      guests: guests.map((guest) => ({
        id: guest.id, name: guest.name, customAmount: guest.custom_amount, groupMemberId: guest.group_member_id,
      })),
      shares: shares.map((share) => ({ itemId: share.order_item_id, guestId: share.guest_id, weight: share.weight })),
      payments: payments.filter((payment) => payment.status === "approved")
        .map((payment) => ({ guestId: payment.guest_id, amount: payment.amount })),
    }),
    payments: payments.map(toPaymentDTO),
    events: events.map(toEventDTO),
  };
};

const getBill = async (ownerId, sessionId, { waiterId = null } = {}) => {
  const session = await getSessionRow({ query }, ownerId, sessionId);
  assertWaiterCanManage(session, waiterId);
  return loadBill({ query }, session);
};

/**
 * Corre un cambio sobre la cuenta con la mesa bloqueada y devuelve la cuenta
 * resultante. `fn` puede devolver datos extra para la respuesta.
 * @param {{ actor: {type,id,name}, waiterId?: number|null }} ctx
 */
const mutate = async (ownerId, sessionId, ctx, fn, { withCash = false } = {}) => {
  const result = await withTransaction(async (client) => {
    // La caja primero: mismo orden de bloqueos que el alta de un pedido.
    const cash = withCash ? await lockOrOpenCashSession(client, ownerId) : null;
    const session = await getSessionRow(client, ownerId, sessionId, { lock: true });
    assertWaiterCanManage(session, ctx.waiterId ?? null);
    if (session.closed_at) throw new OrdersError(409, "Esta mesa ya está cerrada.", "TABLE_CLOSED");
    const extra = await fn(client, session, cash);
    const fresh = await getSessionRow(client, ownerId, sessionId);
    return { ...(extra ?? {}), bill: await loadBill(client, fresh) };
  });
  realtime.emit({ ownerId, event: "table", staff: true });
  return result;
};

const findGuest = async (client, session, guestId) => {
  const { rows } = await client.query(
    "SELECT * FROM bill_guests WHERE id = $1 AND table_session_id = $2 AND removed_at IS NULL",
    [guestId, session.id]
  );
  if (!rows[0]) throw new OrdersError(404, "Ese comensal no está en la cuenta.");
  return rows[0];
};

const guestName = (value) => {
  const name = cleanText(value, LIMITS.billGuestNameLength);
  if (!name) throw new OrdersError(400, "El comensal necesita un nombre.");
  return name;
};

const insertGuest = async (client, session, name, position, groupMemberId = null) => {
  const { rows } = await client.query(
    `INSERT INTO bill_guests (owner_id, table_session_id, name, position, group_member_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [session.owner_id, session.id, name, position, groupMemberId]
  );
  return rows[0];
};

// Posición del próximo comensal y cuántos hay activos.
const guestSlots = async (client, sessionId) => {
  const { rows: [row] } = await client.query(
    `SELECT coalesce(max(position), 0)::int AS last, count(*) FILTER (WHERE removed_at IS NULL)::int AS active
     FROM bill_guests WHERE table_session_id = $1`,
    [sessionId]
  );
  return row;
};

/**
 * Agrega comensales: uno con nombre (`name`) o varios de una (`count`:
 * "Persona 1", "Persona 2"…) para dividir rápido sin tipear.
 */
const addGuests = (ownerId, sessionId, body = {}, ctx) => mutate(ownerId, sessionId, ctx, async (client, session) => {
  const slots = await guestSlots(client, session.id);
  const names = [];
  if (body.count !== undefined && body.count !== null) {
    const count = positiveInt(body.count, { field: "Cantidad de comensales", max: LIMITS.billGuests });
    const taken = new Set((await activeGuests(client, session.id)).map((guest) => guest.name.toLowerCase()));
    for (let number = 1; names.length < count; number += 1) {
      if (!taken.has(`persona ${number}`)) names.push(`Persona ${number}`);
    }
  } else {
    names.push(guestName(body.name));
  }
  if (slots.active + names.length > LIMITS.billGuests) {
    throw new OrdersError(409, `Una cuenta puede tener hasta ${LIMITS.billGuests} comensales.`);
  }
  for (const [index, name] of names.entries()) await insertGuest(client, session, name, slots.last + index + 1);
  await recordEvent(client, session, "guest_added", { names }, ctx.actor);
});

const renameGuest = (ownerId, sessionId, guestId, body = {}, ctx) => mutate(ownerId, sessionId, ctx, async (client, session) => {
  const guest = await findGuest(client, session, guestId);
  const name = guestName(body.name);
  if (name === guest.name) return;
  await client.query("UPDATE bill_guests SET name = $2, updated_at = now() WHERE id = $1", [guest.id, name]);
  await recordEvent(client, session, "guest_renamed", { from: guest.name, to: name }, ctx.actor);
});

// Quita un comensal de la cuenta: lo que tenía asignado vuelve a "sin asignar".
// Con pagos a su nombre no se puede (primero hay que anularlos).
const removeGuest = (ownerId, sessionId, guestId, ctx) => mutate(ownerId, sessionId, ctx, async (client, session) => {
  const guest = await findGuest(client, session, guestId);
  const { rows } = await client.query(
    "SELECT 1 FROM payments WHERE table_session_id = $1 AND guest_id = $2 AND status = 'approved' LIMIT 1",
    [session.id, guest.id]
  );
  if (rows[0]) {
    throw new OrdersError(409, `${guest.name} tiene pagos registrados: anulalos antes de quitarlo.`, "GUEST_HAS_PAYMENTS");
  }
  await client.query("DELETE FROM bill_item_shares WHERE guest_id = $1", [guest.id]);
  await client.query("UPDATE bill_guests SET removed_at = now(), updated_at = now() WHERE id = $1", [guest.id]);
  await recordEvent(client, session, "guest_removed", { name: guest.name }, ctx.actor);
});

/**
 * Modo de división y, en 'custom', el importe de cada comensal
 * (`amounts: [{ guestId, amount }]`; los que no vienen quedan como estaban).
 */
const setSplit = (ownerId, sessionId, body = {}, ctx) => mutate(ownerId, sessionId, ctx, async (client, session) => {
  const mode = body.mode ?? session.split_mode;
  if (!SPLIT_MODES.includes(mode)) throw new OrdersError(400, "Forma de dividir inválida.");

  if (body.amounts !== undefined) {
    if (mode !== "custom") throw new OrdersError(400, "Los importes a mano van con la división por importes.");
    if (!Array.isArray(body.amounts) || body.amounts.length > LIMITS.billGuests) throw new OrdersError(400, "Importes inválidos.");
    const set = [];
    for (const entry of body.amounts) {
      const guest = await findGuest(client, session, positiveInt(entry?.guestId, { field: "Comensal" }));
      const amount = optionalMoney(entry?.amount, "Importe") ?? 0;
      await client.query("UPDATE bill_guests SET custom_amount = $2, updated_at = now() WHERE id = $1", [guest.id, amount]);
      set.push({ name: guest.name, amount });
    }
    if (set.length > 0) await recordEvent(client, session, "amounts_set", { amounts: set }, ctx.actor);
  }

  if (mode !== session.split_mode) {
    await client.query("UPDATE table_sessions SET split_mode = $2, updated_at = now() WHERE id = $1", [session.id, mode]);
    await recordEvent(client, session, "split_changed", { from: session.split_mode, to: mode }, ctx.actor);
  }
  if (mode === "custom") {
    const bill = await loadBill(client, { ...session, split_mode: mode });
    if (bill.overAssigned > 0) {
      throw new OrdersError(409, "Los importes superan el total de la cuenta.", "AMOUNTS_EXCEED_TOTAL");
    }
  }
});

// Línea activa de un pedido que se cobra en esta mesa.
const findBillItem = async (client, session, itemId) => {
  const { rows } = await client.query(
    `SELECT i.id, i.title, i.quantity FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE i.id = $1 AND o.table_session_id = $2 AND o.owner_id = $3
       AND i.status <> 'cancelled' AND NOT (o.status = ANY($4))`,
    [itemId, session.id, session.owner_id, NOT_BILLED_STATUSES]
  );
  if (!rows[0]) throw new OrdersError(404, "Ese producto no está en la cuenta de la mesa.");
  return rows[0];
};

const insertShare = (client, session, itemId, guestId, weight) =>
  client.query(
    `INSERT INTO bill_item_shares (order_item_id, guest_id, owner_id, table_session_id, weight)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (order_item_id, guest_id) DO UPDATE SET weight = EXCLUDED.weight, updated_at = now()`,
    [itemId, guestId, session.owner_id, session.id, weight]
  );

// Asignar productos es dividir por productos: si la mesa no estaba dividida, pasa a ese modo.
const ensureItemsMode = async (client, session, actor) => {
  if (session.split_mode !== "none") return;
  await client.query("UPDATE table_sessions SET split_mode = 'items', updated_at = now() WHERE id = $1", [session.id]);
  await recordEvent(client, session, "split_changed", { from: "none", to: "items" }, actor);
};

/**
 * Reparte un producto: `shares: [{ guestId, weight? }]`. Un solo comensal = el
 * producto entero para él; varios = fraccionado según las partes (weight, 1
 * por defecto). Lista vacía = vuelve a "sin asignar".
 */
const setItemShares = (ownerId, sessionId, itemId, body = {}, ctx) => mutate(ownerId, sessionId, ctx, async (client, session) => {
  if (!Array.isArray(body.shares) || body.shares.length > LIMITS.billGuests) throw new OrdersError(400, "Reparto inválido.");
  const item = await findBillItem(client, session, itemId);
  const seen = new Set();
  const shares = [];
  for (const entry of body.shares) {
    const guest = await findGuest(client, session, positiveInt(entry?.guestId, { field: "Comensal" }));
    if (seen.has(String(guest.id))) throw new OrdersError(400, "Un comensal está repetido en el reparto.");
    seen.add(String(guest.id));
    const weight = entry.weight === undefined || entry.weight === null
      ? 1
      : positiveInt(entry.weight, { field: "Partes", max: LIMITS.shareWeight });
    shares.push({ guest, weight });
  }

  await client.query("DELETE FROM bill_item_shares WHERE order_item_id = $1", [item.id]);
  for (const share of shares) await insertShare(client, session, item.id, share.guest.id, share.weight);
  if (shares.length > 0) await ensureItemsMode(client, session, ctx.actor);
  await recordEvent(client, session, "item_assigned", {
    title: item.title, quantity: item.quantity, guests: shares.map((share) => ({ name: share.guest.name, weight: share.weight })),
  }, ctx.actor);
});

const findPaymentByKey = async (runner, ownerId, key) => {
  const { rows } = await runner.query("SELECT * FROM payments WHERE owner_id = $1 AND idempotency_key = $2", [ownerId, key]);
  return rows[0] ?? null;
};

const duplicatePayment = (existing, sessionId) => {
  if (Number(existing.table_session_id) !== Number(sessionId)) {
    throw new OrdersError(409, "Ese pago ya se registró en otra mesa.");
  }
  return { payment: toPaymentDTO(existing), duplicate: true };
};

/**
 * Registra un pago parcial (o total) de la mesa, cobrado por el personal.
 * @param {object} body  { amount, methodKind, guestId?, payerName?, reference?, idempotencyKey? }
 *   guestId: a qué comensal se le imputa · payerName: quién pagó (si no es un comensal de la cuenta)
 *   idempotencyKey: lo genera el dispositivo por pago; un reintento no cobra dos veces.
 */
const recordPayment = async (ownerId, sessionId, body = {}, ctx) => {
  const amount = positiveMoney(body.amount, "Importe");
  const kind = body.methodKind;
  if (!Object.prototype.hasOwnProperty.call(PAYMENT_KINDS, kind)) throw new OrdersError(400, "Elegí el medio de pago.");
  const guestId = body.guestId === undefined || body.guestId === null || body.guestId === ""
    ? null
    : positiveInt(body.guestId, { field: "Comensal" });
  const payerName = cleanText(body.payerName, LIMITS.payerNameLength);
  const reference = cleanText(body.reference, LIMITS.paymentReferenceLength);
  const key = optionalUuid(body.idempotencyKey);
  const waiter = ctx.actor?.type === "waiter" ? ctx.actor : null;

  try {
    return await mutate(ownerId, sessionId, ctx, async (client, session, cash) => {
      if (key) {
        const existing = await findPaymentByKey(client, ownerId, key);
        if (existing) return duplicatePayment(existing, session.id);
      }
      const guest = guestId ? await findGuest(client, session, guestId) : null;
      const bill = await loadBill(client, session);
      if (toCents(amount) > toCents(bill.pending)) {
        throw new OrdersError(
          409,
          bill.pending > 0 ? `El importe supera lo que falta cobrar ($${bill.pending}).` : "Esta cuenta ya está cobrada.",
          "OVERPAYMENT",
        );
      }
      const { rows: [payment] } = await client.query(
        `INSERT INTO payments (owner_id, cash_session_id, table_session_id, method_name, method_kind, amount, reference,
           waiter_id, waiter_name, idempotency_key, guest_id, payer_name, actor_type, actor_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [ownerId, cash.id, session.id, PAYMENT_KINDS[kind], kind, amount, reference, waiter?.id ?? null, waiter?.name ?? null,
          key, guest?.id ?? null, payerName ?? guest?.name ?? null, ctx.actor?.type ?? null, ctx.actor?.name ?? null]
      );
      await recordEvent(client, session, "payment_recorded", {
        paymentId: Number(payment.id), amount, method: PAYMENT_KINDS[kind], guest: guest?.name ?? null,
        payer: payment.payer_name,
      }, ctx.actor);
      return { payment: toPaymentDTO(payment), duplicate: false };
    }, { withCash: true });
  } catch (error) {
    // Dos reintentos simultáneos del mismo pago: el segundo choca con el UNIQUE
    // de idempotency_key y devuelve el pago del primero.
    if (error.code === "23505" && key) {
      const existing = await findPaymentByKey({ query }, ownerId, key);
      if (existing) return { ...duplicatePayment(existing, sessionId), bill: await getBill(ownerId, sessionId, ctx) };
    }
    throw error;
  }
};

// Anula un pago mal cargado. No se borra: queda en la cuenta como anulado.
const voidPayment = (ownerId, sessionId, paymentId, body = {}, ctx) => mutate(ownerId, sessionId, ctx, async (client, session) => {
  const reason = cleanText(body.reason, LIMITS.statusReasonLength);
  const { rows } = await client.query(
    "SELECT * FROM payments WHERE id = $1 AND owner_id = $2 AND table_session_id = $3 FOR UPDATE",
    [paymentId, ownerId, session.id]
  );
  const payment = rows[0];
  if (!payment) throw new OrdersError(404, "Pago no encontrado.");
  if (payment.status === "voided") return;
  await client.query(
    "UPDATE payments SET status = 'voided', voided_at = now(), void_reason = $2 WHERE id = $1",
    [payment.id, reason]
  );
  await recordEvent(client, session, "payment_voided", {
    paymentId: Number(payment.id), amount: num(payment.amount), method: payment.method_name, payer: payment.payer_name, reason,
  }, ctx.actor);
});

/**
 * Vuelca a la cuenta un pedido que salió de un pedido grupal, dentro de la
 * transacción del alta (con la sesión de mesa ya bloqueada): cada integrante
 * pasa a ser un comensal, sus productos quedan a su nombre y los compartidos
 * se reparten en partes iguales entre los integrantes del grupo.
 * @param {object} input
 * @param {object} input.session  fila de table_sessions
 * @param {Array<{orderItemId, memberId, shared}>} input.lines
 * @param {Array<{id, name}>} input.members  integrantes activos del grupo
 */
const attachGroupOrder = async (client, { session, order, lines, members, actor }) => {
  const existing = await activeGuests(client, session.id);
  const guestOf = new Map(existing.filter((guest) => guest.group_member_id !== null)
    .map((guest) => [String(guest.group_member_id), guest]));
  const anyShared = lines.some((line) => line.shared);
  const needed = members.filter((member) => anyShared || lines.some((line) => String(line.memberId) === String(member.id)));

  const slots = await guestSlots(client, session.id);
  let position = slots.last;
  for (const member of needed) {
    if (guestOf.has(String(member.id))) continue;
    position += 1;
    guestOf.set(String(member.id), await insertGuest(client, session, member.name, position, member.id));
  }

  const everyone = members.map((member) => guestOf.get(String(member.id))).filter(Boolean);
  for (const line of lines) {
    const targets = line.shared ? everyone : [guestOf.get(String(line.memberId))].filter(Boolean);
    for (const guest of targets) await insertShare(client, session, line.orderItemId, guest.id, 1);
  }
  await ensureItemsMode(client, session, actor);
  await recordEvent(client, session, "group_order", { orderNumber: order.number, items: lines.length }, actor);
};

module.exports = {
  getBill,
  addGuests,
  renameGuest,
  removeGuest,
  setSplit,
  setItemShares,
  recordPayment,
  voidPayment,
  attachGroupOrder,
};
