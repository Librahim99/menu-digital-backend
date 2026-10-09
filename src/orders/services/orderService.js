// Pedidos: alta (comensal, operador o panel), cambios de estado y consultas.

const crypto = require("crypto");
const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const {
  ACTIVE_STATUSES, ORDER_STATUSES, STATUS_TRANSITIONS, STATUS_TIMESTAMPS, SERVICE_TYPES, LIMITS,
} = require("../constants");
const { lockOrOpenShift } = require("./shiftService");
const { lockOrOpenCashSession } = require("./cashService");
const { lockOrOpenTableSession } = require("./tableSessionService");
const { priceOrderLines } = require("./menuCatalog");
const { toOrderDTO, withItems } = require("./orderDTO");
const { syncTicketsWithOrder } = require("./ticketService");

// Huella del contenido: mismos productos, variantes, cantidades, aclaraciones
// y mesa = mismo pedido.
const contentHashOf = (lines, tableNumber) => {
  const normalized = lines
    .map((line) => [line.itemId, line.option ?? "", line.quantity, line.notes ?? ""].join("|"))
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(`${tableNumber ?? ""}\n${normalized}`).digest("hex");
};

const findByClientRequest = async (runner, ownerId, clientRequestId) => {
  const { rows } = await runner.query(
    "SELECT * FROM orders WHERE owner_id = $1 AND client_request_id = $2",
    [ownerId, clientRequestId]
  );
  return rows[0] ?? null;
};

// Registro de cambios de estado (incluido el alta): quién, cuándo y por qué.
const recordStatusEvent = (client, { orderId, ownerId, from, to, actor, reason = null }) =>
  client.query(
    `INSERT INTO order_status_events (order_id, owner_id, from_status, to_status, actor_type, actor_id, actor_name, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [orderId, ownerId, from, to, actor?.type ?? "system", actor?.id == null ? null : String(actor.id), actor?.name ?? null, reason]
  );

const EMPTY_CUSTOMER = { name: null, phone: null, address: null, deliveryNotes: null };

/**
 * Crea un pedido.
 * @param {object} input
 * @param {object} input.owner          User (Mongo) del local
 * @param {object} input.settings       fila de order_settings
 * @param {"customer"|"waiter"|"panel"} input.source
 * @param {Array}  input.lines          salida de parseOrderLines
 * @param {"table"|"counter"|"takeaway"|"delivery"} input.serviceType
 * @param {number|null} input.tableNumber   solo serviceType "table"
 * @param {object} input.customer       { name, phone, address, deliveryNotes } (take away / delivery)
 * @param {{id:number,name:string}|null} input.waiter   operador del pedido
 * @param {number|null} input.waiterSessionId  dispositivo del operador que lo cargó
 * @param {string|null} input.notes
 * @param {string|null} input.clientRequestId  idempotencia (reintentos del mismo envío)
 * @param {string|null} input.fingerprint      solo comensales: frecuencia y duplicados
 * @param {number} input.cooldownMs            solo comensales: espera entre pedidos
 * @param {{type,id,name}} input.actor         quién lo cargó (registro de estados)
 * @param {{lines:Array,total:number}|null} input.priced  líneas ya cotizadas por el servidor
 *        (pedidos online: se cobró ese importe, no se vuelve a cotizar)
 * @param {{mode:string,status:string}|null} input.payment  pago online ya acreditado
 * @returns {{ order: object, duplicate: boolean }}
 */
const createOrder = async ({
  owner, settings, source, lines, serviceType = "table", tableNumber = null, customer = EMPTY_CUSTOMER,
  waiter = null, waiterSessionId = null, notes = null, clientRequestId = null, fingerprint = null,
  cooldownMs = LIMITS.customerCooldownMs, actor = null, priced: presetPriced = null, payment = null,
}) => {
  if (!SERVICE_TYPES.includes(serviceType)) throw new OrdersError(400, "Tipo de pedido inválido.");
  if (serviceType === "table" && !tableNumber) throw new OrdersError(400, "Indicá el número de mesa.");
  const table = serviceType === "table" ? tableNumber : null;

  const ownerId = String(owner._id);
  const priced = presetPriced ?? await priceOrderLines(owner, lines);
  const contentHash = fingerprint ? contentHashOf(lines, table) : null;
  // Los pedidos del personal entran confirmados; los del comensal esperan
  // que el local los confirme.
  const status = source === "customer" ? "pending" : "confirmed";

  try {
    return await withTransaction(async (client) => {
      if (clientRequestId) {
        const existing = await findByClientRequest(client, ownerId, clientRequestId);
        if (existing) return { order: (await withItems([existing], client))[0], duplicate: true };
      }

      if (fingerprint) {
        const { rows } = await client.query(
          `SELECT created_at, content_hash FROM orders
           WHERE owner_id = $1 AND client_fingerprint = $2 AND created_at > now() - make_interval(secs => $3)
           ORDER BY created_at DESC LIMIT 5`,
          [ownerId, fingerprint, LIMITS.duplicateWindowMs / 1000]
        );
        if (rows.some((row) => row.content_hash === contentHash)) {
          throw new OrdersError(409, "Ya enviaste este mismo pedido hace un momento.", "DUPLICATE_ORDER");
        }
        if (rows[0] && Date.now() - new Date(rows[0].created_at).getTime() < cooldownMs) {
          throw new OrdersError(429, "Esperá unos segundos antes de enviar otro pedido.", "ORDER_COOLDOWN");
        }
      }

      const shift = await lockOrOpenShift(client, settings);
      const cash = await lockOrOpenCashSession(client, ownerId, shift.id);
      const tableSession = table
        ? await lockOrOpenTableSession(client, { ownerId, tableNumber: table, shiftId: shift.id, waiter })
        : null;
      const next = await client.query(
        "SELECT coalesce(max(number), 0) + 1 AS number FROM orders WHERE shift_id = $1",
        [shift.id]
      );

      const values = [ownerId, shift.id, next.rows[0].number, source, status, serviceType, table, tableSession?.id ?? null,
        cash.id, customer.name, customer.phone, customer.address, customer.deliveryNotes, waiter?.id ?? null,
        waiter?.name ?? null, waiterSessionId, notes, priced.total, clientRequestId, fingerprint, contentHash,
        status === "confirmed" ? new Date() : null];
      const columns = [
        "owner_id", "shift_id", "number", "source", "status", "service_type", "table_number", "table_session_id",
        "cash_session_id", "customer_name", "customer_phone", "delivery_address", "delivery_notes", "waiter_id", "waiter_name",
        "waiter_session_id", "notes", "subtotal", "total", "client_request_id", "client_fingerprint", "content_hash", "confirmed_at",
      ];
      // subtotal y total comparten el mismo valor ($18).
      const placeholders = columns.map((_, index) => `$${index < 18 ? index + 1 : index}`);
      // Las columnas de pago solo se tocan en pedidos online: así el resto de
      // los pedidos no depende de que la migración de pagos esté aplicada.
      if (payment) {
        values.push(payment.mode, payment.status);
        columns.push("payment_mode", "payment_status");
        placeholders.push(`$${values.length - 1}`, `$${values.length}`);
      }
      const { rows: [order] } = await client.query(
        `INSERT INTO orders (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
        values
      );

      for (const line of priced.lines) {
        await client.query(
          `INSERT INTO order_items (order_id, item_id, title, category_id, category_name, section_id, option_name,
             unit_price, quantity, notes, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [order.id, line.itemId, line.title, line.categoryId, line.categoryName, line.sectionId ?? null, line.option,
            line.unitPrice, line.quantity, line.notes, line.position]
        );
      }

      await recordStatusEvent(client, {
        orderId: order.id, ownerId, from: null, to: status, actor: actor ?? { type: source === "customer" ? "customer" : source },
      });
      // Pedido del personal (entra confirmado): sale a los sectores ya.
      await syncTicketsWithOrder(client, { ownerId, orderId: order.id, from: null, to: status });

      return { order: (await withItems([order], client))[0], duplicate: false };
    });
  } catch (error) {
    // Dos reintentos simultáneos del mismo envío: el segundo choca con el
    // UNIQUE de client_request_id y devuelve el pedido del primero.
    if (error.code === "23505" && clientRequestId) {
      const existing = await findByClientRequest({ query }, ownerId, clientRequestId);
      if (existing) return { order: (await withItems([existing]))[0], duplicate: true };
    }
    throw error;
  }
};

// Lo que muestra el panel: todo pedido sin entregar ni cancelar, de
// cualquier turno (un pedido que quedó abierto al cerrar el turno no se pierde).
const listActiveOrders = async (ownerId) => {
  const { rows } = await query(
    "SELECT * FROM orders WHERE owner_id = $1 AND status = ANY($2) ORDER BY created_at",
    [ownerId, ACTIVE_STATUSES]
  );
  return withItems(rows);
};

// Historial con filtros y paginado.
const listOrders = async (ownerId, {
  shiftId, status, serviceType, from, to, tableNumber, page = 1, pageSize = 30,
} = {}) => {
  const where = ["owner_id = $1"];
  const params = [ownerId];
  const add = (clause, value) => {
    params.push(value);
    where.push(clause.replace("?", `$${params.length}`));
  };
  if (shiftId) add("shift_id = ?", shiftId);
  if (status) add("status = ?", status);
  if (serviceType) add("service_type = ?", serviceType);
  if (tableNumber) add("table_number = ?", tableNumber);
  if (from) add("created_at >= ?", from);
  if (to) add("created_at < ?", to);

  const whereSql = where.join(" AND ");
  const [{ rows }, count] = await Promise.all([
    query(
      `SELECT * FROM orders WHERE ${whereSql} ORDER BY created_at DESC LIMIT ${Number(pageSize)} OFFSET ${(Number(page) - 1) * Number(pageSize)}`,
      params
    ),
    query(`SELECT count(*)::int AS total FROM orders WHERE ${whereSql}`, params),
  ]);
  return { orders: await withItems(rows), total: count.rows[0].total, page, pageSize };
};

const getOwnedOrder = async (runner, ownerId, orderId, { lock = false } = {}) => {
  const { rows } = await runner.query(
    `SELECT * FROM orders WHERE owner_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [ownerId, orderId]
  );
  if (!rows[0]) throw new OrdersError(404, "Pedido no encontrado.");
  return rows[0];
};

/**
 * Cambia el estado de un pedido.
 * - Anular o devolver guarda el motivo (opcional).
 * - Una devolución se registra en la caja abierta en ese momento (así no
 *   reescribe una caja ya cerrada) y deja de sumar a la venta.
 * @param {{ reason?: string|null, actor?: {type,id,name} }} options
 */
const updateStatus = async (ownerId, orderId, status, { reason = null, actor = { type: "panel" } } = {}) => {
  if (!ORDER_STATUSES.includes(status)) throw new OrdersError(400, "Estado inválido.");
  return withTransaction(async (client) => {
    const order = await getOwnedOrder(client, ownerId, orderId, { lock: true });
    if (order.status === status) return (await withItems([order], client))[0];
    if (!STATUS_TRANSITIONS[order.status].includes(status)) {
      throw new OrdersError(409, "Ese cambio de estado no es posible para este pedido.");
    }

    const sets = ["status = $3", "updated_at = now()"];
    const params = [ownerId, orderId, status];
    const column = STATUS_TIMESTAMPS[status];
    if (column) sets.push(`${column} = now()`);
    if (status === "cancelled" || status === "returned") {
      params.push(reason);
      sets.push(`status_reason = $${params.length}`);
    } else {
      sets.push("status_reason = NULL");
    }
    if (status === "returned") {
      const cash = await lockOrOpenCashSession(client, ownerId);
      params.push(cash.id);
      sets.push(`returned_cash_session_id = $${params.length}`);
    }

    const { rows } = await client.query(
      `UPDATE orders SET ${sets.join(", ")} WHERE owner_id = $1 AND id = $2 RETURNING *`,
      params
    );
    await recordStatusEvent(client, { orderId, ownerId, from: order.status, to: status, actor, reason });
    await syncTicketsWithOrder(client, { ownerId, orderId, from: order.status, to: status });
    return (await withItems(rows, client))[0];
  });
};

const assignWaiter = async (ownerId, orderId, waiter) => {
  await getOwnedOrder({ query }, ownerId, orderId);
  const { rows } = await query(
    `UPDATE orders SET waiter_id = $3, waiter_name = $4, updated_at = now()
     WHERE owner_id = $1 AND id = $2 RETURNING *`,
    [ownerId, orderId, waiter?.id ?? null, waiter?.name ?? null]
  );
  return (await withItems(rows))[0];
};

// Pedidos que tomó un operador en el turno abierto (para su propio seguimiento).
const listWaiterOrders = async (ownerId, waiterId) => {
  const { rows } = await query(
    `SELECT o.* FROM orders o JOIN shifts s ON s.id = o.shift_id
     WHERE o.owner_id = $1 AND o.waiter_id = $2 AND s.closed_at IS NULL
     ORDER BY o.created_at DESC LIMIT 50`,
    [ownerId, waiterId]
  );
  return withItems(rows);
};

module.exports = {
  toOrderDTO,
  createOrder,
  listActiveOrders,
  listOrders,
  updateStatus,
  assignWaiter,
  listWaiterOrders,
};
