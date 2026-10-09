// Devoluciones de pedidos pagados online, iniciadas desde el panel.
//
// Reglas:
//   · Solo se devuelve sobre el pago original del pedido, con el token del
//     local y dentro de su propio local (owner_id en toda consulta).
//   · Una devolución nace PENDING y pasa a COMPLETED únicamente cuando se
//     confirma el resultado real consultando el pago en Mercado Pago.
//   · Errores definitivos de MP (sin saldo, fuera de plazo…) la dejan FAILED
//     con el detalle; los dudosos (corte de red, 5xx) la dejan PENDING y se
//     puede reintentar con la misma clave de idempotencia sin duplicarla.
//   · Una sola devolución en curso por pago.

const crypto = require("crypto");
const { query, withTransaction } = require("../db/sql");
const { OrdersError } = require("../errors");
const orderService = require("../services/orderService");
const { cleanText } = require("../utils/validate");
const connections = require("./connectionService");
const mpApi = require("./mpApi");
const realtime = require("../delivery/realtime");

const REFUNDABLE = ["APPROVED", "PARTIALLY_REFUNDED"];
const REASON_MAX = 200;
const FAILED_MESSAGE =
  "Mercado Pago rechazó la devolución. Puede ser por falta de saldo disponible en tu cuenta o porque pasó el plazo permitido.";

const cents = (value) => Math.round(Number(value) * 100);
const fromCents = (value) => value / 100;

const toRefundDTO = (row) => ({
  id: row.id,
  amount: Number(row.amount),
  isPartial: row.is_partial,
  reason: row.reason,
  status: row.status,
  failureDetail: row.failure_detail,
  requestedByName: row.requested_by_name,
  requestedAt: row.requested_at,
  completedAt: row.completed_at,
});

const toPaymentDTO = (row, refunds = []) => {
  const pending = refunds.filter((r) => r.status === "PENDING").reduce((sum, r) => sum + cents(r.amount), 0);
  const remaining = REFUNDABLE.includes(row.status)
    ? Math.max(0, cents(row.amount) - cents(row.refunded_amount) - pending)
    : 0;
  return {
    status: row.status,
    amount: Number(row.amount),
    refundedAmount: Number(row.refunded_amount),
    refundable: fromCents(remaining),
    canRefund: remaining > 0 && pending === 0,
  };
};

const findOnlinePayment = async (runner, ownerId, orderId, { lock = false } = {}) => {
  const { rows } = await runner.query(
    `SELECT * FROM order_online_payments WHERE owner_id = $1 AND order_id = $2${lock ? " FOR UPDATE" : ""}`,
    [ownerId, orderId],
  );
  return rows[0] ?? null;
};

// Pago y devoluciones de un pedido (para el detalle del panel).
const getOrderPayment = async (ownerId, orderId) => {
  const payment = await findOnlinePayment({ query }, ownerId, orderId);
  if (!payment) return null;
  const { rows } = await query(
    "SELECT * FROM order_refunds WHERE owner_id = $1 AND online_payment_id = $2 ORDER BY requested_at DESC",
    [ownerId, payment.id],
  );
  return { payment: toPaymentDTO(payment, rows), refunds: rows.map(toRefundDTO) };
};

const parseAmount = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1e9) throw new OrdersError(400, "El importe a devolver es inválido.");
  return Math.round(number * 100) / 100;
};

// Confirma contra MP que la devolución existe y quedó aprobada.
const confirmWithMp = (mpPayment, { mpRefundId, previousRefunded, amount }) => {
  const listed = Array.isArray(mpPayment.refunds) ? mpPayment.refunds : [];
  const byId = mpRefundId && listed.find((r) => String(r.id) === String(mpRefundId));
  if (byId) return byId.status ? byId.status === "approved" : true;
  return cents(mpPayment.transaction_amount_refunded) >= previousRefunded + cents(amount);
};

const paymentStatusFor = (amount, refunded) => (cents(refunded) >= cents(amount) ? "REFUNDED" : "PARTIALLY_REFUNDED");

const markCompleted = async (refund, payment, refundedTotal) => {
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE order_refunds SET status = 'COMPLETED', completed_at = now(), failure_detail = NULL, updated_at = now() WHERE id = $1 AND status <> 'COMPLETED'",
      [refund.id],
    );
    const total = Math.max(Number(payment.refunded_amount), refundedTotal);
    const status = paymentStatusFor(payment.amount, total);
    await client.query(
      "UPDATE order_online_payments SET refunded_amount = $2, status = $3, updated_at = now() WHERE id = $1",
      [payment.id, total, status],
    );
    await client.query(
      "UPDATE orders SET payment_status = $3, updated_at = now() WHERE id = $2 AND owner_id = $1",
      [payment.owner_id, payment.order_id, status],
    );
  });
  // Devolución confirmada: el panel y el seguimiento del cliente se actualizan solos.
  realtime.emit({ ownerId: payment.owner_id, event: "payment", orderId: Number(payment.order_id), customer: true });
};

const markFailed = (refund, detail) =>
  query(
    "UPDATE order_refunds SET status = 'FAILED', failure_detail = $2, updated_at = now() WHERE id = $1 AND status = 'PENDING'",
    [refund.id, detail],
  );

// Ejecuta (o reintenta) la devolución en MP y confirma su resultado.
const processRefund = async ({ ownerId, payment, refund }) => {
  const seller = await connections.getAccessToken(ownerId);

  // La cuenta de MP conectada tiene que ser la que cobró ese pago.
  const { rows: [original] } = await query("SELECT mp_user_id FROM order_mp_connections WHERE id = $1", [payment.connection_id]);
  if (!original || original.mp_user_id !== seller.mpUserId) {
    throw new OrdersError(
      409,
      "La cuenta de Mercado Pago conectada no es la que cobró este pedido. Conectá esa cuenta para devolverlo.",
      "MP_ACCOUNT_CHANGED",
    );
  }

  const previousRefunded = cents(payment.refunded_amount);
  let created;
  try {
    created = await mpApi.createRefund(
      seller.accessToken,
      payment.mp_payment_id,
      refund.is_partial ? Number(refund.amount) : null,
      refund.idempotency_key,
    );
  } catch (error) {
    if (!(error instanceof mpApi.MpApiError)) throw error;
    const definitive = error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
    if (definitive) {
      await markFailed(refund, `mp_${error.status}${error.mpCode ? `_${error.mpCode}` : ""}`);
      return { refund: { ...refund, status: "FAILED", failure_detail: "mp_error" }, outcome: "failed", message: FAILED_MESSAGE };
    }
    // Dudoso: puede haberse procesado. Queda pendiente y se reintenta con la misma clave.
    return { refund, outcome: "pending" };
  }

  const mpPayment = await mpApi.getPayment(seller.accessToken, payment.mp_payment_id).catch(() => null);
  if (mpPayment && confirmWithMp(mpPayment, { mpRefundId: created.id, previousRefunded, amount: refund.amount })) {
    if (created.id) await query("UPDATE order_refunds SET mp_refund_id = $2 WHERE id = $1", [refund.id, created.id]);
    await markCompleted(refund, payment, Number(mpPayment.transaction_amount_refunded) || previousRefunded / 100 + Number(refund.amount));
    return { refund: { ...refund, status: "COMPLETED" }, outcome: "completed" };
  }
  if (created.id) await query("UPDATE order_refunds SET mp_refund_id = $2 WHERE id = $1", [refund.id, created.id]);
  return { refund, outcome: "pending" };
};

/**
 * Pide la devolución (total si no se indica importe) de un pedido pagado online.
 * Con `cancelOrder`, el pedido se anula SOLO si la devolución quedó confirmada.
 */
const requestRefund = async ({ ownerId, orderId, amount, reason, cancelOrder = false, actor }) => {
  const requested = parseAmount(amount);
  const cleanReason = cleanText(reason, REASON_MAX);

  const { payment, refund } = await withTransaction(async (client) => {
    const payment = await findOnlinePayment(client, ownerId, orderId, { lock: true });
    if (!payment) throw new OrdersError(404, "Este pedido no tiene un pago online para devolver.");
    if (!REFUNDABLE.includes(payment.status) || !payment.mp_payment_id) {
      throw new OrdersError(409, "Este pedido no tiene un pago aprobado para devolver.", "NOT_REFUNDABLE");
    }

    const { rows: pendingRows } = await client.query(
      "SELECT 1 FROM order_refunds WHERE online_payment_id = $1 AND status = 'PENDING'",
      [payment.id],
    );
    if (pendingRows.length > 0) {
      throw new OrdersError(409, "Ya hay una devolución en curso para este pedido.", "REFUND_IN_PROGRESS");
    }

    const remaining = cents(payment.amount) - cents(payment.refunded_amount);
    if (remaining <= 0) throw new OrdersError(409, "Este pedido ya fue devuelto por completo.", "NOT_REFUNDABLE");
    const wanted = requested == null ? remaining : cents(requested);
    if (wanted > remaining) {
      throw new OrdersError(400, `Podés devolver como máximo $${fromCents(remaining).toFixed(2)}.`, "AMOUNT_EXCEEDS");
    }

    const { rows: [refund] } = await client.query(
      `INSERT INTO order_refunds
         (owner_id, order_id, online_payment_id, amount, is_partial, reason, idempotency_key, requested_by_id, requested_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        ownerId, orderId, payment.id, fromCents(wanted), wanted < remaining || cents(payment.refunded_amount) > 0,
        cleanReason, crypto.randomUUID(), String(actor?.id ?? ownerId), actor?.name ?? null,
      ],
    );
    return { payment, refund };
  });

  const result = await processRefund({ ownerId, payment, refund });

  let orderCancelled = false;
  if (result.outcome === "completed" && cancelOrder) {
    try {
      await orderService.updateStatus(ownerId, orderId, "cancelled", {
        reason: cleanReason ?? "Pedido rechazado con devolución",
        actor: { type: "panel", id: actor?.id, name: actor?.name },
      });
      orderCancelled = true;
    } catch (error) {
      // La devolución ya está hecha; si el pedido no se puede anular (estado), se avisa.
      if (!(error instanceof OrdersError)) throw error;
    }
  }

  const state = await getOrderPayment(ownerId, orderId);
  return { ...state, outcome: result.outcome, orderCancelled, message: result.message ?? null };
};

// Reintenta una devolución pendiente con la MISMA clave de idempotencia.
const retryRefund = async ({ ownerId, orderId, refundId }) => {
  const id = Number(refundId);
  if (!Number.isSafeInteger(id) || id < 1) throw new OrdersError(404, "Devolución no encontrada.");
  const { rows: [refund] } = await query(
    "SELECT * FROM order_refunds WHERE id = $1 AND owner_id = $2 AND order_id = $3",
    [id, ownerId, orderId],
  );
  if (!refund) throw new OrdersError(404, "Devolución no encontrada.");
  if (refund.status !== "PENDING") throw new OrdersError(409, "Esa devolución ya no está pendiente.", "REFUND_NOT_PENDING");
  const payment = await findOnlinePayment({ query }, ownerId, orderId);
  if (!payment) throw new OrdersError(404, "Este pedido no tiene un pago online para devolver.");
  const result = await processRefund({ ownerId, payment, refund });
  const state = await getOrderPayment(ownerId, orderId);
  return { ...state, outcome: result.outcome, orderCancelled: false, message: result.message ?? null };
};

/**
 * Lo llama el webhook al conocer cuánto lleva devuelto un pago: si hay una
 * devolución pendiente y MP ya refleja su importe, queda COMPLETED.
 */
const completePendingRefunds = async (payment) => {
  const refunded = cents(payment.refunded_amount);
  if (refunded <= 0) return;
  const { rows } = await query(
    "SELECT * FROM order_refunds WHERE online_payment_id = $1 AND status IN ('PENDING', 'COMPLETED') ORDER BY id",
    [payment.id],
  );
  const completed = rows.filter((r) => r.status === "COMPLETED").reduce((sum, r) => sum + cents(r.amount), 0);
  const pending = rows.find((r) => r.status === "PENDING");
  if (pending && refunded - completed >= cents(pending.amount)) {
    await query(
      "UPDATE order_refunds SET status = 'COMPLETED', completed_at = now(), failure_detail = NULL, updated_at = now() WHERE id = $1 AND status = 'PENDING'",
      [pending.id],
    );
  }
};

module.exports = { getOrderPayment, requestRefund, retryRefund, completePendingRefunds };
