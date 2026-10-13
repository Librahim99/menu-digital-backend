// Pedidos grupales: lo que hace el comensal desde su celular (abrir un grupo
// en su mesa, sumarse, cargar productos, enviar) y lo que hace el personal
// desde la app del operador o desde Mesas en el panel.

const { route, OrdersError } = require("../errors");
const groupService = require("../services/groupService");
const settingsService = require("../services/settingsService");
const { findProOwnerBySlug } = require("../services/menuCatalog");
const { isTokenShape } = require("../utils/tokens");
const {
  parseOrderLines, positiveInt, optionalPositiveInt, optionalUuid, cleanText,
} = require("../utils/validate");
const { LIMITS } = require("../constants");

const idParam = (req, name = "id") => positiveInt(req.params[name], { field: "Identificador" });

// Productos que se agregan al carrito: los de un pedido, más si son para
// compartir y el id del envío (un reintento no los carga dos veces).
const parseGroupLines = (items) => parseOrderLines(items).map((line, index) => {
  const raw = items[index];
  if (raw.shared !== undefined && typeof raw.shared !== "boolean") throw new OrdersError(400, "Indicá si es para compartir.");
  return { ...line, shared: raw.shared === true, clientItemId: optionalUuid(raw.clientItemId) };
});

// ── Comensal ─────────────────────────────────

const proOwner = async (slug) => {
  const owner = await findProOwnerBySlug(slug);
  if (!owner) throw new OrdersError(404, "Este local no recibe pedidos desde la carta.");
  return owner;
};

// Abre el pedido grupal de su mesa (o se suma al que ya está abierto). Hay que
// estar en el local: lo prueba el token del QR, igual que para pedir.
const openFromVenue = route(async (req, res) => {
  const body = req.body ?? {};
  if (!isTokenShape(body.token)) throw new OrdersError(403, "Para pedir en grupo, escaneá el QR del local.");
  const owner = await proOwner(req.params.slug);
  const settings = await settingsService.findSettings(String(owner._id));
  const qr = await settingsService.resolveQrToken(settings, body.token);
  if (!qr) throw new OrdersError(403, "El QR ya no es válido. Volvé a escanear el de tu mesa.", "QR_INVALID");
  const tableNumber = qr.kind === "table"
    ? qr.tableNumber
    : optionalPositiveInt(body.tableNumber, { field: "Número de mesa", max: settings.table_count });
  if (!tableNumber) throw new OrdersError(400, "Indicá tu número de mesa para pedir en grupo.");

  const result = await groupService.openGroup(String(owner._id), tableNumber, {
    // Sin nombre no se abre: el comensal que lo abre siempre queda como integrante.
    creator: { type: "customer", name: null }, hostName: body.name ?? "",
  });
  res.status(201).json({ memberToken: result.memberToken, group: result.group });
});

// Se suma con el código que le pasaron o con el QR / enlace del grupo.
const join = route(async (req, res) => {
  const body = req.body ?? {};
  const owner = await proOwner(req.params.slug);
  const result = await groupService.joinGroup(String(owner._id), {
    code: typeof body.code === "string" ? body.code : null,
    joinToken: body.joinToken ?? null,
    name: body.name,
  });
  res.status(201).json(result);
});

const memberGroup = (req) => groupService.getGroup(req.groupMember.ownerId, req.groupMember.groupId, {
  memberId: req.groupMember.memberId,
});

const me = route(async (req, res) => {
  res.json({
    group: await memberGroup(req),
    member: { id: req.groupMember.memberId, name: req.groupMember.name },
    // false: el carrito lo envía el personal (el local no recibe pedidos directos del comensal).
    ordering: req.orderSettings.customer_ordering,
  });
});

const addItems = route(async (req, res) => {
  const group = await groupService.addCartItems(req.owner, req.groupMember, parseGroupLines(req.body?.items));
  res.status(201).json({ group });
});

const updateItem = route(async (req, res) => {
  res.json({ group: await groupService.updateCartItem(req.groupMember, idParam(req, "itemId"), req.body ?? {}) });
});

const removeItem = route(async (req, res) => {
  const { ownerId, groupId } = req.groupMember;
  res.json({ group: await groupService.removeCartItem(ownerId, groupId, idParam(req, "itemId"), { member: req.groupMember }) });
});

const send = route(async (req, res) => {
  if (!req.orderSettings.customer_ordering) {
    throw new OrdersError(403, "En este local el pedido lo envía el personal: avisale a quien los atiende.", "CUSTOMER_ORDERING_OFF");
  }
  const { memberId, name, groupId, tableNumber } = req.groupMember;
  const { order, duplicate, group } = await groupService.submitGroup({
    owner: req.owner,
    settings: req.orderSettings,
    groupId,
    source: "customer",
    actor: { type: "customer", id: memberId, name: `${name} · Mesa ${tableNumber}` },
    clientRequestId: optionalUuid(req.body?.clientRequestId),
    memberId,
  });
  // Al comensal, lo justo para confirmarle el envío.
  res.status(duplicate ? 200 : 201).json({
    order: { number: order.number, tableNumber: order.tableNumber, total: order.total, createdAt: order.createdAt },
    duplicate,
    group,
  });
});

const leave = route(async (req, res) => {
  await groupService.leaveGroup(req.groupMember);
  res.status(204).end();
});

// ── Personal (operador o panel) ──────────────

/**
 * @param {(req) => { ownerId, owner, source: "waiter"|"panel", waiter, waiterSessionId, actor }} who
 */
const staffRoutes = (who) => ({
  list: route(async (req, res) => {
    res.json({ groups: await groupService.listOpenGroups(who(req).ownerId) });
  }),

  // Abre el pedido grupal de una mesa para que los comensales se sumen con el QR o el código.
  open: route(async (req, res) => {
    const { ownerId, actor } = who(req);
    const tableNumber = positiveInt(req.body?.tableNumber, { field: "Número de mesa", max: req.orderSettings.table_count });
    const { group, created } = await groupService.openGroup(ownerId, tableNumber, {
      creator: { type: actor.type, name: actor.name },
    });
    res.status(created ? 201 : 200).json({ group });
  }),

  send: route(async (req, res) => {
    const { owner, source, waiter, waiterSessionId, actor } = who(req);
    const { order, duplicate, group } = await groupService.submitGroup({
      owner,
      settings: req.orderSettings,
      groupId: idParam(req),
      source,
      waiter,
      waiterSessionId,
      actor,
      clientRequestId: optionalUuid(req.body?.clientRequestId),
      notes: cleanText(req.body?.notes, LIMITS.orderNotesLength),
    });
    res.status(duplicate ? 200 : 201).json({ order, duplicate, group });
  }),

  removeItem: route(async (req, res) => {
    res.json({ group: await groupService.removeCartItem(who(req).ownerId, idParam(req), idParam(req, "itemId")) });
  }),

  close: route(async (req, res) => {
    res.json({ group: await groupService.closeGroup(who(req).ownerId, idParam(req)) });
  }),
});

const waiter = staffRoutes((req) => {
  const { waiterId, name, sessionId } = req.waiterSession;
  return {
    ownerId: String(req.owner._id),
    owner: req.owner,
    source: "waiter",
    waiter: { id: waiterId, name },
    waiterSessionId: sessionId,
    actor: { type: "waiter", id: waiterId, name },
  };
});

const owner = staffRoutes((req) => ({
  ownerId: String(req.user._id),
  owner: req.user,
  source: "panel",
  waiter: null,
  waiterSessionId: null,
  actor: { type: "panel", id: String(req.user._id), name: "Panel" },
}));

module.exports = { openFromVenue, join, me, addItems, updateItem, removeItem, send, leave, waiter, owner };
