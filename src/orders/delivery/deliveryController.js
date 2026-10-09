// Delivery en el panel del local (JWT + plan PRO): /api/orders/delivery/*.

const { route, OrdersError } = require("../errors");
const courierService = require("./courierService");
const deliveryService = require("./deliveryService");
const { positiveInt, optionalPositiveInt, cleanText } = require("../utils/validate");
const { LIMITS } = require("../constants");

const ownerIdOf = (req) => String(req.user._id);
const idParam = (req, name = "id") => positiveInt(req.params[name], { field: "Identificador" });
const reasonOf = (req) => cleanText(req.body?.reason, LIMITS.statusReasonLength);

// ── Entregas ─────────────────────────────────

const listActive = route(async (req, res) => {
  res.json(await deliveryService.listActive(ownerIdOf(req), { settings: req.orderSettings }));
});

const assign = route(async (req, res) => {
  const courierId = positiveInt(req.body?.courierId, { field: "Repartidor" });
  const assignment = await deliveryService.assignOrder(ownerIdOf(req), idParam(req), {
    courierId, force: req.body?.force === true, reason: reasonOf(req), settings: req.orderSettings,
  });
  res.json({ assignment });
});

const unassign = route(async (req, res) => {
  await deliveryService.unassignOrder(ownerIdOf(req), idParam(req), { reason: reasonOf(req) });
  res.status(204).end();
});

// Entrega marcada por el administrador (incidencias): motivo y registro.
const complete = route(async (req, res) => {
  const order = await deliveryService.adminDeliver(ownerIdOf(req), idParam(req), {
    reason: reasonOf(req), settings: req.orderSettings,
  });
  res.json({ order });
});

const trail = route(async (req, res) => {
  res.json(await deliveryService.getTrail(ownerIdOf(req), idParam(req)));
});

const revealCode = route(async (req, res) => {
  res.json({ code: await deliveryService.revealCode(ownerIdOf(req), idParam(req)) });
});

// ── Repartidores ─────────────────────────────

const listCouriers = route(async (req, res) => {
  res.json({ couriers: await courierService.listCouriers(ownerIdOf(req)) });
});

const createCourier = route(async (req, res) => {
  res.status(201).json({ courier: await courierService.createCourier(ownerIdOf(req), req.body) });
});

const reassignParam = (req) => optionalPositiveInt(req.body?.reassignTo ?? req.query.reassignTo, { field: "Repartidor" });

const updateCourier = route(async (req, res) => {
  res.json({
    courier: await courierService.updateCourier(ownerIdOf(req), idParam(req), req.body, { reassignActive: reassignParam(req) }),
  });
});

const deleteCourier = route(async (req, res) => {
  await courierService.deleteCourier(ownerIdOf(req), idParam(req), { reassignActive: reassignParam(req) });
  res.status(204).end();
});

const issuePairingCode = route(async (req, res) => {
  res.json(await courierService.issuePairingCode(ownerIdOf(req), idParam(req)));
});

const revokePairingCode = route(async (req, res) => {
  await courierService.revokePairingCode(ownerIdOf(req), idParam(req));
  res.status(204).end();
});

const listSessions = route(async (req, res) => {
  res.json({ sessions: await courierService.listSessions(ownerIdOf(req), idParam(req)) });
});

const revokeSessions = route(async (req, res) => {
  await courierService.revokeSessions(ownerIdOf(req), idParam(req));
  res.status(204).end();
});

const revokeSession = route(async (req, res) => {
  await courierService.revokeSession(ownerIdOf(req), idParam(req), idParam(req, "sessionId"));
  res.status(204).end();
});

// Seguimiento del cliente: lo que ve de su envío (código incluido, mientras está en camino).
// Pública: la referencia del pago es el secreto que identifica el pedido.
const customerDelivery = route(async (req, res) => {
  const { findProOwnerBySlug } = require("../services/menuCatalog");
  const settingsService = require("../services/settingsService");
  const owner = await findProOwnerBySlug(req.params.slug);
  if (!owner) throw new OrdersError(404, "Este local no recibe pedidos desde la carta.");
  const settings = await settingsService.findSettings(String(owner._id));
  res.json(await deliveryService.customerDelivery(String(owner._id), req.params.ref, { settings }));
});

module.exports = {
  listActive, assign, unassign, complete, trail, revealCode, listCouriers, createCourier, updateCourier, deleteCourier,
  issuePairingCode, revokePairingCode, listSessions, revokeSessions, revokeSession, customerDelivery,
};
