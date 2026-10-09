// App del repartidor (celular, acceso por QR): /api/orders/courier/*.
// Autenticación "Authorization: Courier <token>" (ver protectCourier).

const { route } = require("../errors");
const courierService = require("./courierService");
const deliveryService = require("./deliveryService");
const { businessNameOf, findOwnerById } = require("../services/menuCatalog");
const { positiveInt, optionalPositiveInt } = require("../utils/validate");

const sessionPayload = (owner, session) => ({
  courier: { id: session.courierId, name: session.name, available: session.available },
  business: { slug: owner?.slug ?? "", name: businessNameOf(owner) },
  sessionStartedAt: session.startedAt ?? null,
});

const idParam = (req) => positiveInt(req.params.id, { field: "Pedido" });

// Canje del código del QR por el token del dispositivo.
const pair = route(async (req, res) => {
  const { token, courier, ownerId } = await courierService.pairDevice(req.body?.code, {
    userAgent: req.headers["user-agent"],
  });
  const owner = await findOwnerById(ownerId);
  res.status(201).json({
    token,
    courier: { ...courier, available: false },
    business: { slug: owner?.slug ?? "", name: businessNameOf(owner) },
  });
});

const me = route(async (req, res) => {
  res.json(sessionPayload(req.owner, req.courierSession));
});

const logout = route(async (req, res) => {
  await courierService.endSession(req.courierSession);
  res.status(204).end();
});

const setAvailability = route(async (req, res) => {
  const available = await courierService.setAvailability(req.courierSession, req.body?.available);
  res.json({ available });
});

// Pendientes de retirar, en camino y (modo abierto) pedidos disponibles. Es la
// fuente de verdad: los avisos del WebSocket solo dicen cuándo volver a pedirla.
const panel = route(async (req, res) => {
  res.json({
    ...sessionPayload(req.owner, req.courierSession),
    ...(await deliveryService.courierPanel(req.courierSession, { settings: req.orderSettings })),
  });
});

const history = route(async (req, res) => {
  res.json(await deliveryService.courierHistory(req.courierSession, {
    page: optionalPositiveInt(req.query.page, { field: "Página", max: 10_000 }) ?? 1,
  }));
});

const getOrder = route(async (req, res) => {
  res.json({ order: await deliveryService.courierOrder(req.courierSession, idParam(req), { settings: req.orderSettings }) });
});

const claim = route(async (req, res) => {
  await deliveryService.claimOrder(req.courierSession, idParam(req), { settings: req.orderSettings });
  res.json({ order: await deliveryService.courierOrder(req.courierSession, idParam(req), { settings: req.orderSettings }) });
});

const pickup = route(async (req, res) => {
  const { repeated } = await deliveryService.pickupOrder(req.courierSession, idParam(req), { settings: req.orderSettings });
  res.json({
    repeated,
    order: await deliveryService.courierOrder(req.courierSession, idParam(req), { settings: req.orderSettings }),
  });
});

const deliver = route(async (req, res) => {
  res.json(await deliveryService.confirmDelivery(req.courierSession, idParam(req), req.body?.code));
});

module.exports = { pair, me, logout, setAvailability, panel, history, getOrder, claim, pickup, deliver };
