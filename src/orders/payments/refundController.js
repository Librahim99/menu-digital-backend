const { OrdersError, route } = require("../errors");
const refunds = require("./refundService");

const ownerIdOf = (req) => String(req.user._id);

const orderIdOf = (req) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new OrdersError(404, "Pedido no encontrado.");
  return id;
};

// Quién pidió la devolución (queda registrado junto con fecha, importe y motivo).
const actorOf = (req) => ({
  id: String(req.user._id),
  name: req.user.username || req.user.contactInfo?.businessName || null,
});

// Pago y devoluciones del pedido (null si el pedido no se pagó online).
const getOrderPayment = route(async (req, res) => {
  res.json((await refunds.getOrderPayment(ownerIdOf(req), orderIdOf(req))) ?? { payment: null, refunds: [] });
});

const requestRefund = route(async (req, res) => {
  const { amount, reason, cancelOrder } = req.body ?? {};
  const result = await refunds.requestRefund({
    ownerId: ownerIdOf(req),
    orderId: orderIdOf(req),
    amount,
    reason,
    cancelOrder: cancelOrder === true,
    actor: actorOf(req),
  });
  // 201 si quedó confirmada; 202 si MP todavía no la confirmó; 422 si MP la rechazó.
  const status = result.outcome === "completed" ? 201 : result.outcome === "failed" ? 422 : 202;
  res.status(status).json(result);
});

const retryRefund = route(async (req, res) => {
  const result = await refunds.retryRefund({
    ownerId: ownerIdOf(req), orderId: orderIdOf(req), refundId: req.params.refundId,
  });
  res.status(result.outcome === "completed" ? 200 : result.outcome === "failed" ? 422 : 202).json(result);
});

module.exports = { getOrderPayment, requestRefund, retryRefund };
