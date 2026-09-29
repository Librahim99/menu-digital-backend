// Panel de Gestión de pedidos del dueño del local (JWT + plan PRO).

const { route, OrdersError } = require("../errors");
const settingsService = require("../services/settingsService");
const shiftService = require("../services/shiftService");
const orderService = require("../services/orderService");
const waiterService = require("../services/waiterService");
const {
  parseOrderLines, cleanText, optionalPositiveInt, positiveInt,
} = require("../utils/validate");
const { LIMITS, ORDER_STATUSES } = require("../constants");

const ownerIdOf = (req) => String(req.user._id);
const idParam = (req, name = "id") => positiveInt(req.params[name], { field: "Identificador" });

// ── Configuración ────────────────────────────

const getSettings = route(async (req, res) => {
  const [tables, openShift] = await Promise.all([
    settingsService.listTables(ownerIdOf(req)),
    shiftService.findOpenShift(ownerIdOf(req)),
  ]);
  res.json({
    settings: settingsService.toSettingsDTO(req.orderSettings),
    tables,
    slug: req.user.slug,
    openShift: shiftService.toShiftDTO(openShift),
  });
});

const updateSettings = route(async (req, res) => {
  const row = await settingsService.updateSettings(ownerIdOf(req), req.body);
  const tables = await settingsService.listTables(ownerIdOf(req));
  res.json({ settings: settingsService.toSettingsDTO(row), tables, slug: req.user.slug });
});

const regenerateQr = route(async (req, res) => {
  await settingsService.regenerateQr(ownerIdOf(req), req.body?.target);
  const [settings, tables] = await Promise.all([
    settingsService.getOrCreateSettings(ownerIdOf(req)),
    settingsService.listTables(ownerIdOf(req)),
  ]);
  res.json({ settings: settingsService.toSettingsDTO(settings), tables, slug: req.user.slug });
});

// ── Panel de pedidos ─────────────────────────

// Lo que consulta el panel cada pocos segundos.
const getBoard = route(async (req, res) => {
  const [orders, openShift] = await Promise.all([
    orderService.listActiveOrders(ownerIdOf(req)),
    shiftService.findOpenShift(ownerIdOf(req)),
  ]);
  res.json({ orders, openShift: shiftService.toShiftDTO(openShift), serverTime: new Date().toISOString() });
});

const listOrders = route(async (req, res) => {
  const { shiftId, status, from, to, table, page } = req.query;
  if (status && !ORDER_STATUSES.includes(status)) throw new OrdersError(400, "Estado inválido.");
  const parseDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new OrdersError(400, "Fecha inválida.");
    return date;
  };
  res.json(await orderService.listOrders(ownerIdOf(req), {
    shiftId: optionalPositiveInt(shiftId, { field: "Turno" }),
    status: status || null,
    tableNumber: optionalPositiveInt(table, { field: "Mesa" }),
    from: parseDate(from),
    to: parseDate(to),
    page: optionalPositiveInt(page, { field: "Página", max: 10_000 }) ?? 1,
  }));
});

// Pedido cargado a mano desde el panel.
const createOrder = route(async (req, res) => {
  const settings = req.orderSettings;
  const tableNumber = optionalPositiveInt(req.body?.tableNumber, { field: "Mesa", max: settings.table_count });
  const waiterId = optionalPositiveInt(req.body?.waiterId, { field: "Mozo" });
  const waiter = waiterId ? await waiterService.getWaiter(ownerIdOf(req), waiterId) : null;

  const { order } = await orderService.createOrder({
    owner: req.user,
    settings,
    source: "panel",
    lines: parseOrderLines(req.body?.items),
    tableNumber,
    waiter: waiter && { id: Number(waiter.id), name: waiter.name },
    notes: cleanText(req.body?.notes, LIMITS.orderNotesLength),
  });
  res.status(201).json({ order });
});

const updateOrderStatus = route(async (req, res) => {
  const order = await orderService.updateStatus(ownerIdOf(req), idParam(req), req.body?.status);
  res.json({ order });
});

const assignOrderWaiter = route(async (req, res) => {
  const waiterId = optionalPositiveInt(req.body?.waiterId, { field: "Mozo" });
  const waiter = waiterId ? await waiterService.getWaiter(ownerIdOf(req), waiterId) : null;
  const order = await orderService.assignWaiter(ownerIdOf(req), idParam(req), waiter && { id: Number(waiter.id), name: waiter.name });
  res.json({ order });
});

// ── Turnos y caja ────────────────────────────

const listShifts = route(async (req, res) => {
  const page = optionalPositiveInt(req.query.page, { field: "Página", max: 10_000 }) ?? 1;
  res.json(await shiftService.listShifts(ownerIdOf(req), { page }));
});

const openShift = route(async (req, res) => {
  const shift = await shiftService.openShift(req.orderSettings);
  res.status(201).json({ shift: shiftService.toShiftDTO(shift) });
});

// Resumen del turno abierto (o del turno :id).
const getShiftSummary = route(async (req, res) => {
  const ownerId = ownerIdOf(req);
  const shift = req.params.id === "current"
    ? await shiftService.findOpenShift(ownerId)
    : await shiftService.getShift(ownerId, idParam(req));
  if (!shift) return res.json({ shift: null, summary: null });
  res.json({ shift: shiftService.toShiftDTO(shift), summary: await shiftService.shiftSummary(ownerId, shift.id) });
});

const closeShift = route(async (req, res) => {
  const rawCash = req.body?.cashCounted;
  let cashCounted = null;
  if (rawCash !== undefined && rawCash !== null && rawCash !== "") {
    cashCounted = Number(rawCash);
    if (!Number.isFinite(cashCounted) || cashCounted < 0 || cashCounted > 1e10) {
      throw new OrdersError(400, "El efectivo contado es inválido.");
    }
  }
  const shift = await shiftService.closeShift(ownerIdOf(req), {
    cashCounted,
    notes: cleanText(req.body?.notes, 300),
    force: req.body?.force === true,
  });
  res.json({ shift });
});

// ── Mozos ────────────────────────────────────

const listWaiters = route(async (req, res) => {
  res.json({ waiters: await waiterService.listWaiters(ownerIdOf(req)) });
});

const createWaiter = route(async (req, res) => {
  res.status(201).json({ waiter: await waiterService.createWaiter(ownerIdOf(req), req.body) });
});

const updateWaiter = route(async (req, res) => {
  res.json({ waiter: await waiterService.updateWaiter(ownerIdOf(req), idParam(req), req.body) });
});

const deleteWaiter = route(async (req, res) => {
  await waiterService.deleteWaiter(ownerIdOf(req), idParam(req));
  res.status(204).end();
});

const issuePairingCode = route(async (req, res) => {
  res.json(await waiterService.issuePairingCode(ownerIdOf(req), idParam(req)));
});

const revokeWaiterSessions = route(async (req, res) => {
  await waiterService.revokeSessions(ownerIdOf(req), idParam(req));
  res.status(204).end();
});

module.exports = {
  getSettings,
  updateSettings,
  regenerateQr,
  getBoard,
  listOrders,
  createOrder,
  updateOrderStatus,
  assignOrderWaiter,
  listShifts,
  openShift,
  getShiftSummary,
  closeShift,
  listWaiters,
  createWaiter,
  updateWaiter,
  deleteWaiter,
  issuePairingCode,
  revokeWaiterSessions,
};
