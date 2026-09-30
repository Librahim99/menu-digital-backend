// Tomador de pedidos de los operadores (celular/tablet, acceso por QR).
// Además de tomar pedidos, el operador maneja sus mesas abiertas (la cuenta
// de cada una y su cierre) y ve el historial de las mesas que cerró.

const { route } = require("../errors");
const waiterService = require("../services/waiterService");
const orderService = require("../services/orderService");
const tableSessionService = require("../services/tableSessionService");
const { businessNameOf, findOwnerById } = require("../services/menuCatalog");
const {
  parseOrderLines, parseService, positiveInt, optionalPositiveInt, cleanText, optionalUuid,
} = require("../utils/validate");
const { LIMITS } = require("../constants");

const sessionPayload = (owner, settings, waiter, session = null) => ({
  waiter,
  business: { slug: owner?.slug ?? "", name: businessNameOf(owner) },
  tableCount: settings?.table_count ?? null,
  sessionStartedAt: session?.startedAt ?? null,
});

const ownerIdOf = (req) => String(req.owner._id);
const idParam = (req) => positiveInt(req.params.id, { field: "Identificador" });
const waiterActor = (req) => ({ type: "waiter", id: req.waiterSession.waiterId, name: req.waiterSession.name });

// Canje del código del QR por el token del dispositivo.
const pair = route(async (req, res) => {
  const { token, waiter, ownerId } = await waiterService.pairDevice(req.body?.code, {
    userAgent: req.headers["user-agent"],
  });
  const owner = await findOwnerById(ownerId);
  res.status(201).json({ token, ...sessionPayload(owner, null, waiter) });
});

const me = route(async (req, res) => {
  const { waiterId, name } = req.waiterSession;
  res.json(sessionPayload(req.owner, req.orderSettings, { id: waiterId, name }, req.waiterSession));
});

const logout = route(async (req, res) => {
  await waiterService.endSession(req.waiterSession.sessionId);
  res.status(204).end();
});

const createOrder = route(async (req, res) => {
  const settings = req.orderSettings;
  const body = req.body ?? {};
  const { waiterId, name, sessionId } = req.waiterSession;
  const { serviceType, tableNumber, customer } = parseService(body, { tableCount: settings.table_count });
  const { order, duplicate } = await orderService.createOrder({
    owner: req.owner,
    settings,
    source: "waiter",
    lines: parseOrderLines(body.items),
    serviceType,
    tableNumber,
    customer,
    waiter: { id: waiterId, name },
    waiterSessionId: sessionId,
    notes: cleanText(body.notes, LIMITS.orderNotesLength),
    clientRequestId: optionalUuid(body.clientRequestId),
    actor: waiterActor(req),
  });
  res.status(duplicate ? 200 : 201).json({ order, duplicate });
});

const myOrders = route(async (req, res) => {
  const orders = await orderService.listWaiterOrders(ownerIdOf(req), req.waiterSession.waiterId);
  res.json({ orders });
});

// "Mis mesas": las mesas abiertas del operador y las que no tomó nadie
// todavía (ej. abiertas por un pedido del comensal), con sus pedidos.
const myTables = route(async (req, res) => {
  const { sessions } = await tableSessionService.listSessions(ownerIdOf(req), {
    status: "open",
    waiterId: req.waiterSession.waiterId,
    includeUnassigned: true,
    withOrders: true,
    pageSize: 100,
  });
  res.json({ sessions });
});

const closeTable = route(async (req, res) => {
  const session = await tableSessionService.closeSession(ownerIdOf(req), idParam(req), {
    force: req.body?.force === true,
    actor: { type: "waiter", name: req.waiterSession.name },
    waiterId: req.waiterSession.waiterId,
  });
  res.json({ session });
});

const updateTable = route(async (req, res) => {
  const session = await tableSessionService.setGuests(ownerIdOf(req), idParam(req), req.body?.guests, {
    waiterId: req.waiterSession.waiterId,
  });
  res.json({ session });
});

// Historial: mesas que atendió y ya se cerraron.
const myHistory = route(async (req, res) => {
  res.json(await tableSessionService.listSessions(ownerIdOf(req), {
    status: "closed",
    waiterId: req.waiterSession.waiterId,
    withOrders: true,
    page: optionalPositiveInt(req.query.page, { field: "Página", max: 10_000 }) ?? 1,
    pageSize: 15,
  }));
});

module.exports = { pair, me, logout, createOrder, myOrders, myTables, closeTable, updateTable, myHistory };
