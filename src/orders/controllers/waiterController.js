// Tomador de pedidos de los mozos (celular/tablet, acceso por QR).

const { route } = require("../errors");
const waiterService = require("../services/waiterService");
const orderService = require("../services/orderService");
const { businessNameOf, findOwnerById } = require("../services/menuCatalog");
const { parseOrderLines, positiveInt, cleanText, optionalUuid } = require("../utils/validate");
const { LIMITS } = require("../constants");

const sessionPayload = (owner, settings, waiter) => ({
  waiter,
  business: { slug: owner?.slug ?? "", name: businessNameOf(owner) },
  tableCount: settings?.table_count ?? null,
});

// Canje del código del QR por el token del dispositivo.
const pair = route(async (req, res) => {
  const { token, waiter, ownerId } = await waiterService.pairDevice(req.body?.code);
  const owner = await findOwnerById(ownerId);
  res.status(201).json({ token, ...sessionPayload(owner, null, waiter) });
});

const me = route(async (req, res) => {
  const { waiterId, name } = req.waiterSession;
  res.json(sessionPayload(req.owner, req.orderSettings, { id: waiterId, name }));
});

const logout = route(async (req, res) => {
  await waiterService.endSession(req.waiterSession.sessionId);
  res.status(204).end();
});

const createOrder = route(async (req, res) => {
  const settings = req.orderSettings;
  const { waiterId, name } = req.waiterSession;
  const { order, duplicate } = await orderService.createOrder({
    owner: req.owner,
    settings,
    source: "waiter",
    lines: parseOrderLines(req.body?.items),
    tableNumber: positiveInt(req.body?.tableNumber, { field: "Número de mesa", max: settings.table_count }),
    waiter: { id: waiterId, name },
    notes: cleanText(req.body?.notes, LIMITS.orderNotesLength),
    clientRequestId: optionalUuid(req.body?.clientRequestId),
  });
  res.status(duplicate ? 200 : 201).json({ order, duplicate });
});

const myOrders = route(async (req, res) => {
  const orders = await orderService.listWaiterOrders(String(req.owner._id), req.waiterSession.waiterId);
  res.json({ orders });
});

module.exports = { pair, me, logout, createOrder, myOrders };
