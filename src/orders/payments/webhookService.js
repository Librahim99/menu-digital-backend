// Notificaciones de pago de Mercado Pago para pedidos online.
//
// Reglas:
//   · La firma se valida antes de tocar nada (ver signature.js).
//   · El resultado NUNCA sale de la notificación ni de la URL de retorno: se
//     consulta el pago a la API de MP con el token del local dueño de la cuenta.
//   · Cada pago se valida contra el carrito guardado: mismo local, mismo
//     importe y moneda. Un pago que no coincide no crea ni aprueba nada.
//   · Es idempotente: una notificación repetida, o que llegue fuera de orden,
//     no duplica pedidos ni retrocede el estado de un pago.
//   · El pedido se crea recién cuando el pago está aprobado.

const crypto = require("crypto");
const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const { findOwnerById } = require("../services/menuCatalog");
const settingsService = require("../services/settingsService");
const orderService = require("../services/orderService");
const connections = require("./connectionService");
const refunds = require("./refundService");
const mpApi = require("./mpApi");
const realtime = require("../delivery/realtime");

const REF_RE = /^[0-9a-f]{48}$/;
const AMOUNT_TOLERANCE = 0.005;
// Orden de "avance" de un pago: el estado no retrocede (salvo reintento de pago).
const RANK = { PENDING: 0, REJECTED: 1, APPROVED: 2, PARTIALLY_REFUNDED: 3, REFUNDED: 4 };
const PAID_STATUSES = ["APPROVED", "PARTIALLY_REFUNDED", "REFUNDED"];

// Estado de MP → estado del pago en Menú Digital (null = no cambia).
const mapStatus = (payment, amount) => {
  const refunded = Number(payment.transaction_amount_refunded) || 0;
  switch (payment.status) {
    case "approved":
      if (refunded >= amount - AMOUNT_TOLERANCE) return "REFUNDED";
      return refunded > 0 ? "PARTIALLY_REFUNDED" : "APPROVED";
    case "refunded":
      return "REFUNDED";
    case "rejected":
    case "cancelled":
      return "REJECTED";
    case "pending":
    case "in_process":
    case "in_mediation":
    case "authorized":
      return "PENDING";
    default:
      return null; // charged_back u otros: se guarda el estado crudo, el nuestro no cambia
  }
};

const eventKeyOf = (topic, paymentId, requestId) =>
  crypto.createHash("sha256").update(`${topic}:${paymentId}:${requestId ?? ""}`).digest("hex");

const finishEvent = (eventId, outcome, ownerId = null) =>
  query(
    "UPDATE order_mp_webhook_events SET outcome = $2, owner_id = $3, processed_at = now() WHERE id = $1",
    [eventId, outcome, ownerId],
  );

// Crea el pedido de un pago aprobado (una sola vez). Idempotente: el id del
// envío del cliente es único por local, así que dos notificaciones en paralelo
// terminan en el mismo pedido.
const ensureOrder = async (row, paymentStatus) => {
  if (row.order_id) return row.order_id;
  const owner = await findOwnerById(row.owner_id);
  if (!owner) throw new Error(`Local ${row.owner_id} no encontrado al crear el pedido pagado`);
  const settings = await settingsService.getOrCreateSettings(row.owner_id);
  const draft = row.draft;

  const { order } = await orderService.createOrder({
    owner,
    settings,
    source: "customer",
    lines: [],
    priced: { lines: draft.lines, total: draft.total },
    serviceType: draft.serviceType,
    customer: draft.customer,
    notes: draft.notes ?? null,
    clientRequestId: row.client_request_id,
    actor: { type: "customer", name: draft.customer?.name ?? null },
    payment: { mode: "mercadopago", status: paymentStatus },
  });
  await query(
    "UPDATE order_online_payments SET order_id = $2, updated_at = now() WHERE id = $1 AND order_id IS NULL",
    [row.id, order.id],
  );
  return order.id;
};

/**
 * Procesa una notificación de pago ya autenticada (firma válida).
 * @returns {{ outcome: string }} applied · duplicate · ignored · stale · amount_mismatch · duplicate_payment
 */
const processPaymentNotification = async ({ mpUserId, paymentId, requestId, topic = "payment" }) => {
  const key = eventKeyOf(topic, paymentId, requestId);
  const inserted = await query(
    `INSERT INTO order_mp_webhook_events (event_key, topic, mp_payment_id) VALUES ($1, $2, $3)
     ON CONFLICT (event_key) DO NOTHING RETURNING id`,
    [key, topic, String(paymentId)],
  );
  let eventId = inserted.rows[0]?.id;
  if (!eventId) {
    const previous = await query("SELECT id, processed_at FROM order_mp_webhook_events WHERE event_key = $1", [key]);
    if (previous.rows[0]?.processed_at) return { outcome: "duplicate" };
    eventId = previous.rows[0]?.id; // quedó a medias (error): se reintenta
  }

  try {
    const outcome = await handle({ mpUserId, paymentId, eventId });
    return { outcome };
  } catch (error) {
    await query("UPDATE order_mp_webhook_events SET outcome = 'error' WHERE id = $1", [eventId]).catch(() => {});
    throw error;
  }
};

const handle = async ({ mpUserId, paymentId, eventId }) => {
  // La cuenta de MP dueña del pago identifica al local.
  const { rows: [connection] } = mpUserId == null ? { rows: [] } : await query(
    `SELECT owner_id, mp_user_id FROM order_mp_connections
      WHERE mp_user_id = $1 AND status IN ('active', 'error')`,
    [String(mpUserId)],
  );
  if (!connection) {
    await finishEvent(eventId, "ignored");
    return "ignored";
  }
  const ownerId = connection.owner_id;

  let seller;
  try {
    seller = await connections.getAccessToken(ownerId);
  } catch (error) {
    // Sin acceso al local no hay nada que confirmar (desconectado / revocado).
    if (error instanceof OrdersError && error.code === "MP_NOT_CONNECTED") {
      await finishEvent(eventId, "ignored", ownerId);
      return "ignored";
    }
    throw error;
  }

  let payment;
  try {
    payment = await mpApi.getPayment(seller.accessToken, paymentId);
  } catch (error) {
    if (error instanceof mpApi.MpApiError && error.status === 404) {
      await finishEvent(eventId, "ignored", ownerId);
      return "ignored";
    }
    throw error; // transitorio: MP reintenta la notificación
  }

  // El pago tiene que ser de la cuenta del local y traer nuestra referencia.
  const collectorOk = payment.collector_id == null || String(payment.collector_id) === String(connection.mp_user_id);
  const ref = payment.external_reference;
  if (!collectorOk || typeof ref !== "string" || !REF_RE.test(ref)) {
    await finishEvent(eventId, "ignored", ownerId);
    return "ignored";
  }

  const result = await applyPayment({ ownerId, payment, ref }).catch((error) => {
    // El pago ya figura en otro carrito (UNIQUE de mp_payment_id): no se asocia.
    if (error?.code === "23505") return { outcome: "ignored" };
    throw error;
  });

  if (result.outcome !== "applied") {
    await finishEvent(eventId, result.outcome, result.ownerId ?? ownerId);
    return result.outcome;
  }

  // Fuera de la transacción: crear el pedido tiene la suya (idempotente).
  const { row } = result;
  // Una devolución pedida desde el panel se da por completa cuando MP ya la refleja.
  if (Number(row.refunded_amount) > 0) await refunds.completePendingRefunds(row);
  if (["APPROVED", "PARTIALLY_REFUNDED"].includes(row.status) && !row.order_id) {
    await ensureOrder(row, row.status);
  } else if (row.order_id && PAID_STATUSES.includes(row.status)) {
    await query(
      "UPDATE orders SET payment_status = $3, updated_at = now() WHERE id = $2 AND owner_id = $1",
      [ownerId, row.order_id, row.status],
    );
  }

  await finishEvent(eventId, "applied", ownerId);
  // El cliente que espera en la pantalla de retorno se entera sin consultar cada
  // pocos segundos; el panel, si cambió el pago de un pedido que ya existía.
  realtime.emitToCustomer(ownerId, ref, "payment");
  if (row.order_id) realtime.emit({ ownerId, event: "payment", orderId: Number(row.order_id) });
  return "applied";
};

// Aplica el estado del pago al carrito dentro de una transacción (fila bloqueada).
const applyPayment = ({ ownerId, payment, ref }) => withTransaction(async (client) => {
    const { rows: [row] } = await client.query(
      "SELECT * FROM order_online_payments WHERE external_reference = $1 AND owner_id = $2 FOR UPDATE",
      [ref, ownerId],
    );
    if (!row) return { outcome: "ignored" };

    const mpPaymentId = String(payment.id);
    const amount = Number(row.amount);
    const next = mapStatus(payment, amount);
    const rebinding = Boolean(row.mp_payment_id) && row.mp_payment_id !== mpPaymentId;

    if (rebinding && PAID_STATUSES.includes(row.status)) {
      // Ya hay un pago acreditado para este carrito: otro intento posterior no lo pisa.
      if (next && PAID_STATUSES.includes(next)) {
        console.error(`[orders/payments] Pago duplicado: carrito ${row.id} ya pagado, llegó el pago ${mpPaymentId}. Requiere devolución manual.`);
        return { outcome: "duplicate_payment", ownerId };
      }
      return { outcome: "stale", ownerId };
    }

    if (!rebinding && row.last_event_at && payment.date_last_updated
      && new Date(payment.date_last_updated).getTime() < new Date(row.last_event_at).getTime()) {
      return { outcome: "stale", ownerId };
    }

    if (next && PAID_STATUSES.includes(next)) {
      const sameAmount = Math.abs(Number(payment.transaction_amount) - amount) < AMOUNT_TOLERANCE;
      if (!sameAmount || payment.currency_id !== "ARS") {
        console.error(`[orders/payments] Importe o moneda no coinciden en el carrito ${row.id} (pago ${mpPaymentId}). No se aprueba.`);
        return { outcome: "amount_mismatch", ownerId };
      }
    }

    // El estado no retrocede, salvo cuando es otro intento de pago del mismo carrito.
    let status = row.status;
    if (next && (rebinding || RANK[next] >= RANK[row.status])) status = next;

    const { rows: [updated] } = await client.query(
      `UPDATE order_online_payments
          SET mp_payment_id = $2, status = $3, mp_status = $4, mp_status_detail = $5,
              refunded_amount = $6,
              approved_at = CASE WHEN $3 IN ('APPROVED', 'PARTIALLY_REFUNDED', 'REFUNDED')
                                 THEN coalesce(approved_at, $7::timestamptz) ELSE approved_at END,
              last_event_at = $8::timestamptz, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [
        row.id, mpPaymentId, status, payment.status ?? null, payment.status_detail ?? null,
        Number(payment.transaction_amount_refunded) || 0,
        payment.date_approved ?? new Date().toISOString(),
        payment.date_last_updated ?? new Date().toISOString(),
      ],
    );
    return { outcome: "applied", ownerId, row: updated };
});

module.exports = { processPaymentNotification, mapStatus, eventKeyOf };
