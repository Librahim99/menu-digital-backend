// Pedidos que no siguen su curso natural: lo que se puede hacer con UN producto
// de un pedido en curso, sin tocar el resto.
//
// - Quitar un producto (o parte de su cantidad): falta de stock, error de carga
//   o lo pidió el cliente. La línea no se borra: queda 'cancelled' con su
//   motivo y el total del pedido se recalcula. Si el pedido estaba pagado
//   online, la diferencia queda como importe a devolver (ver orderDTO.refundDue):
//   la devolución la confirma el local desde el panel, no es automática.
// - Restaurar un producto quitado por error.
// - Entregar en partes: cada producto se marca entregado por separado (la
//   bebida antes que la comida). Cuando no queda nada por entregar, el pedido
//   pasa solo a "entregado".

const { withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { ACTIVE_STATUSES } = require("../constants");
const { withItems, dispatchedAtOf } = require("./orderDTO");
const { issueTickets, cancelEmptyTickets } = require("./ticketService");
const orderService = require("./orderService");
const realtime = require("../delivery/realtime");

// Estados en los que hay comandas en los sectores.
const WITH_TICKETS = ["confirmed", "ready"];

const isActiveLine = (line) => line.status !== "cancelled";
const lineAmount = (line, quantity = line.quantity) => Math.round(Number(line.unit_price) * quantity * 100) / 100;

const lockLines = async (client, orderId) => {
  const { rows } = await client.query(
    "SELECT * FROM order_items WHERE order_id = $1 ORDER BY position, id FOR UPDATE",
    [orderId]
  );
  return rows;
};

const findLine = (lines, itemId) => {
  const line = lines.find((row) => Number(row.id) === Number(itemId));
  if (!line) throw new OrdersError(404, "Ese producto no está en el pedido.");
  return line;
};

const recordItemEvent = (client, { ownerId, orderId, itemId, type, quantity, amount, reason = null, actor }) =>
  client.query(
    `INSERT INTO order_item_events (owner_id, order_id, order_item_id, event_type, quantity, amount, reason,
       actor_type, actor_id, actor_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [ownerId, orderId, itemId, type, quantity, amount, reason, actor?.type ?? "system",
      actor?.id == null ? null : String(actor.id), actor?.name ?? null]
  );

// El total del pedido es siempre el de sus líneas activas (menos el descuento).
const recalculateTotals = async (client, ownerId, orderId) => {
  const { rows } = await client.query(
    `UPDATE orders SET subtotal = lines.amount, total = greatest(lines.amount - discount_amount, 0), updated_at = now()
     FROM (SELECT coalesce(sum(unit_price * quantity), 0) AS amount FROM order_items
           WHERE order_id = $2 AND status <> 'cancelled') lines
     WHERE owner_id = $1 AND id = $2 RETURNING orders.*`,
    [ownerId, orderId]
  );
  return rows[0];
};

const assertEditable = (order) => {
  if (!ACTIVE_STATUSES.includes(order.status)) {
    throw new OrdersError(409, "Solo se pueden cambiar los productos de un pedido en curso.", "ORDER_NOT_ACTIVE");
  }
  if (dispatchedAtOf(order)) {
    throw new OrdersError(409, "El pedido ya salió del local.", "ORDER_DISPATCHED");
  }
};

const notify = (ownerId, order) =>
  realtime.emit({ ownerId, event: "order_status", orderId: Number(order.id), orderNumber: order.number, customer: true, openList: true, staff: true });

/**
 * Quita un producto del pedido (o `quantity` unidades de esa línea).
 * No se puede quitar lo último que queda: eso es anular el pedido.
 * @param {{ quantity?: number|null, reason?: string|null, actor?: {type,id,name} }} options
 */
const removeItem = async (ownerId, orderId, itemId, { quantity = null, reason = null, actor = { type: "panel" } } = {}) => {
  const result = await withTransaction(async (client) => {
    const order = await orderService.getOwnedOrder(client, ownerId, orderId, { lock: true });
    assertEditable(order);
    const lines = await lockLines(client, order.id);
    const line = findLine(lines, itemId);
    // Reintento del mismo pedido: ya está quitado.
    if (!isActiveLine(line)) return (await withItems([order], client))[0];
    if (line.delivered_at) throw new OrdersError(409, "Ese producto ya se entregó.", "ITEM_DELIVERED");

    const units = quantity ?? line.quantity;
    if (!Number.isSafeInteger(units) || units < 1 || units > line.quantity) {
      throw new OrdersError(400, "Cantidad inválida.");
    }
    const others = lines.filter((row) => isActiveLine(row) && row.id !== line.id);
    if (units === line.quantity && others.length === 0) {
      throw new OrdersError(409, "Es lo único que queda en el pedido: cancelá el pedido completo.", "LAST_ITEM");
    }

    let removedId = line.id;
    if (units === line.quantity) {
      await client.query(
        "UPDATE order_items SET status = 'cancelled', cancelled_at = now(), status_reason = $2 WHERE id = $1",
        [line.id, reason]
      );
    } else {
      // Parte de la cantidad: la línea sigue con lo que queda y lo quitado va a
      // una línea aparte (misma comanda), así el historial muestra las dos cosas.
      await client.query("UPDATE order_items SET quantity = quantity - $2 WHERE id = $1", [line.id, units]);
      const { rows } = await client.query(
        `INSERT INTO order_items (order_id, item_id, title, category_id, category_name, section_id, option_name,
           unit_price, quantity, notes, position, ticket_id, status, cancelled_at, status_reason)
         SELECT order_id, item_id, title, category_id, category_name, section_id, option_name,
           unit_price, $2, notes, position, ticket_id, 'cancelled', now(), $3
         FROM order_items WHERE id = $1 RETURNING id`,
        [line.id, units, reason]
      );
      removedId = rows[0].id;
    }

    await recordItemEvent(client, {
      ownerId, orderId: order.id, itemId: removedId, type: "removed", quantity: units, amount: lineAmount(line, units), reason, actor,
    });
    await cancelEmptyTickets(client, order.id);
    const updated = await recalculateTotals(client, ownerId, order.id);
    return (await withItems([updated], client))[0];
  });
  notify(ownerId, result);
  return result;
};

/**
 * Vuelve a poner en el pedido un producto quitado. Con plata ya devuelta no se
 * puede: el total volvería a superar lo que el cliente tiene pagado.
 */
const restoreItem = async (ownerId, orderId, itemId, { actor = { type: "panel" } } = {}) => {
  const result = await withTransaction(async (client) => {
    const order = await orderService.getOwnedOrder(client, ownerId, orderId, { lock: true });
    assertEditable(order);
    const lines = await lockLines(client, order.id);
    const line = findLine(lines, itemId);
    if (isActiveLine(line)) return (await withItems([order], client))[0];
    if (order.payment_mode === "mercadopago" && order.payment_status !== "APPROVED") {
      throw new OrdersError(
        409, "Ya se devolvió plata de este pedido: no se puede volver a sumar el producto. Cargalo en un pedido nuevo.",
        "ORDER_REFUNDED",
      );
    }

    await client.query(
      "UPDATE order_items SET status = 'active', cancelled_at = NULL, status_reason = NULL WHERE id = $1",
      [line.id]
    );
    await recordItemEvent(client, {
      ownerId, orderId: order.id, itemId: line.id, type: "restored", quantity: line.quantity, amount: lineAmount(line), actor,
    });
    // Vuelve a su comanda (o a una nueva, si se había quitado antes de confirmar).
    if (WITH_TICKETS.includes(order.status)) await issueTickets(client, { ownerId, orderId: order.id });
    const updated = await recalculateTotals(client, ownerId, order.id);
    return (await withItems([updated], client))[0];
  });
  notify(ownerId, result);
  return result;
};

/**
 * Entrega en partes: marca (o desmarca) un producto como entregado. Con todo
 * entregado el pedido pasa a "entregado" en la misma transacción.
 * Delivery no aplica: sale completo y lo confirma el repartidor o el panel.
 */
const setItemDelivered = async (ownerId, orderId, itemId, delivered, { actor = { type: "panel" } } = {}) => {
  if (typeof delivered !== "boolean") throw new OrdersError(400, "Indicá si el producto se entregó.");
  const result = await withTransaction(async (client) => {
    const order = await orderService.getOwnedOrder(client, ownerId, orderId, { lock: true });
    if (order.service_type === "delivery") {
      throw new OrdersError(409, "Los pedidos de delivery se entregan completos.", "DELIVERY_NOT_PARTIAL");
    }
    if (!WITH_TICKETS.includes(order.status)) {
      throw new OrdersError(
        409,
        order.status === "pending" ? "Confirmá el pedido antes de entregar productos." : "Este pedido ya no está en curso.",
        "ORDER_NOT_ACTIVE",
      );
    }
    const lines = await lockLines(client, order.id);
    const line = findLine(lines, itemId);
    if (!isActiveLine(line)) throw new OrdersError(409, "Ese producto se quitó del pedido.", "ITEM_REMOVED");
    if (Boolean(line.delivered_at) === delivered) return (await withItems([order], client))[0];

    await client.query(
      `UPDATE order_items SET delivered_at = ${delivered ? "now()" : "NULL"} WHERE id = $1`,
      [line.id]
    );
    await recordItemEvent(client, {
      ownerId, orderId: order.id, itemId: line.id, type: delivered ? "delivered" : "undelivered",
      quantity: line.quantity, amount: lineAmount(line), actor,
    });

    const pending = lines.filter((row) => isActiveLine(row) && row.id !== line.id && !row.delivered_at);
    if (delivered && pending.length === 0) {
      return orderService.applyStatusChange(client, ownerId, order, "delivered", { actor });
    }
    return (await withItems([order], client))[0];
  });
  notify(ownerId, result);
  return result;
};

module.exports = { removeItem, restoreItem, setItemDelivered };
