// Panel de Gestión de pedidos del dueño del local (JWT + plan PRO).

const { route, OrdersError } = require("../errors");
const settingsService = require("../services/settingsService");
const shiftService = require("../services/shiftService");
const orderService = require("../services/orderService");
const orderItemService = require("../services/orderItemService");
const waiterService = require("../services/waiterService");
const tableSessionService = require("../services/tableSessionService");
const cashService = require("../services/cashService");
const reportService = require("../services/reportService");
const { buildStatsPeriod } = require("../../utils/statsPeriod");
const deliveryService = require("../delivery/deliveryService");
const realtime = require("../delivery/realtime");
const {
  parseOrderLines, parseService, cleanText, optionalPositiveInt, positiveInt, optionalUuid,
} = require("../utils/validate");
const { LIMITS, ORDER_STATUSES, SERVICE_TYPES } = require("../constants");

const ownerIdOf = (req) => String(req.user._id);
const idParam = (req, name = "id") => positiveInt(req.params[name], { field: "Identificador" });
const pageParam = (req) => optionalPositiveInt(req.query.page, { field: "Página", max: 10_000 }) ?? 1;
// Quién hace el cambio desde el panel (registro de estados y cierres).
// Cambió un operador o sus dispositivos: el panel y los tomadores vuelven a consultar
// (un dispositivo al que se le cerró el acceso se entera en el momento).
const notifyDevices = (req) => realtime.emit({ ownerId: ownerIdOf(req), event: "devices", staff: true });
const panelActor = (req) => ({ type: "panel", id: ownerIdOf(req), name: "Panel" });

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
  const wasEnabled = deliveryService.deliveryConfig(req.orderSettings).enabled;
  const row = await settingsService.updateSettings(ownerIdOf(req), req.body);
  // Al apagar Delivery lo que no se retiró vuelve a "sin asignar"; lo que ya salió se puede terminar de entregar.
  if (wasEnabled && !deliveryService.deliveryConfig(row).enabled) {
    await deliveryService.releasePendingOnDisable(ownerIdOf(req));
  }
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
  // Cada pedido de reparto muestra su repartidor y cómo va (también con Delivery apagado: lo que
  // ya salió se sigue viendo). Si la consulta falla, el tablero sigue sin ese dato.
  const withDelivery = await deliveryService.attachDelivery(ownerIdOf(req), orders).catch(() => orders);
  res.json({ orders: withDelivery, openShift: shiftService.toShiftDTO(openShift), serverTime: new Date().toISOString() });
});

const listOrders = route(async (req, res) => {
  const { shiftId, status, serviceType, from, to, table, courier } = req.query;
  if (status && !ORDER_STATUSES.includes(status)) throw new OrdersError(400, "Estado inválido.");
  if (serviceType && !SERVICE_TYPES.includes(serviceType)) throw new OrdersError(400, "Tipo de pedido inválido.");
  const parseDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new OrdersError(400, "Fecha inválida.");
    return date;
  };
  const result = await orderService.listOrders(ownerIdOf(req), {
    courierId: optionalPositiveInt(courier, { field: "Repartidor" }),
    shiftId: optionalPositiveInt(shiftId, { field: "Turno" }),
    status: status || null,
    serviceType: serviceType || null,
    tableNumber: optionalPositiveInt(table, { field: "Mesa" }),
    from: parseDate(from),
    to: parseDate(to),
    page: pageParam(req),
  });
  // El historial de delivery es el mismo historial general, filtrado, con el repartidor y los tiempos.
  if (serviceType === "delivery" || courier) {
    result.orders = await deliveryService.attachDelivery(ownerIdOf(req), result.orders);
  }
  res.json(result);
});

// Pedido cargado a mano desde el panel (barra, teléfono, delivery…).
const createOrder = route(async (req, res) => {
  const settings = req.orderSettings;
  const body = req.body ?? {};
  const { serviceType, tableNumber, customer } = parseService(body, { tableCount: settings.table_count });
  const waiterId = optionalPositiveInt(body.waiterId, { field: "Operador" });
  const waiter = waiterId ? await waiterService.getWaiter(ownerIdOf(req), waiterId) : null;

  const { order, duplicate } = await orderService.createOrder({
    owner: req.user,
    settings,
    source: "panel",
    lines: parseOrderLines(body.items),
    serviceType,
    tableNumber,
    customer,
    waiter: waiter && { id: Number(waiter.id), name: waiter.name },
    notes: cleanText(body.notes, LIMITS.orderNotesLength),
    clientRequestId: optionalUuid(body.clientRequestId),
    actor: panelActor(req),
  });
  res.status(duplicate ? 200 : 201).json({ order, duplicate });
});

const updateOrderStatus = route(async (req, res) => {
  const order = await orderService.updateStatus(ownerIdOf(req), idParam(req), req.body?.status, {
    reason: cleanText(req.body?.reason, LIMITS.statusReasonLength),
    actor: panelActor(req),
  });
  res.json({ order });
});

// Delivery: el pedido salió del local (entre Listo y Entregado).
const dispatchOrder = route(async (req, res) => {
  res.json({ order: await orderService.markDispatched(ownerIdOf(req), idParam(req)) });
});

// ── Productos de un pedido en curso ──────────
// Quitar (falta de stock, error de carga), restaurar y entregar en partes.

const removeOrderItem = route(async (req, res) => {
  const body = req.body ?? {};
  const order = await orderItemService.removeItem(ownerIdOf(req), idParam(req), idParam(req, "itemId"), {
    quantity: optionalPositiveInt(body.quantity, { field: "Cantidad", max: LIMITS.quantityPerLine }),
    reason: cleanText(body.reason, LIMITS.itemReasonLength),
    actor: panelActor(req),
  });
  res.json({ order });
});

const restoreOrderItem = route(async (req, res) => {
  const order = await orderItemService.restoreItem(ownerIdOf(req), idParam(req), idParam(req, "itemId"), {
    actor: panelActor(req),
  });
  res.json({ order });
});

const setOrderItemDelivered = route(async (req, res) => {
  const order = await orderItemService.setItemDelivered(
    ownerIdOf(req), idParam(req), idParam(req, "itemId"), req.body?.delivered, { actor: panelActor(req) },
  );
  res.json({ order });
});

const assignOrderWaiter = route(async (req, res) => {
  const waiterId = optionalPositiveInt(req.body?.waiterId, { field: "Operador" });
  const waiter = waiterId ? await waiterService.getWaiter(ownerIdOf(req), waiterId) : null;
  const order = await orderService.assignWaiter(ownerIdOf(req), idParam(req), waiter && { id: Number(waiter.id), name: waiter.name });
  res.json({ order });
});

// ── Sesiones de mesa ─────────────────────────

const listTableSessions = route(async (req, res) => {
  const status = req.query.status === "closed" ? "closed" : "open";
  res.json(await tableSessionService.listSessions(ownerIdOf(req), {
    status,
    withOrders: status === "open",
    page: pageParam(req),
  }));
});

const getTableSession = route(async (req, res) => {
  res.json({ session: await tableSessionService.getSession(ownerIdOf(req), idParam(req)) });
});

const closeTableSession = route(async (req, res) => {
  const session = await tableSessionService.closeSession(ownerIdOf(req), idParam(req), {
    force: req.body?.force === true,
    actor: { type: "panel", name: "Panel" },
  });
  res.json({ session });
});

const updateTableSession = route(async (req, res) => {
  res.json({ session: await tableSessionService.setGuests(ownerIdOf(req), idParam(req), req.body?.guests) });
});

// ── Turnos ───────────────────────────────────

const listShifts = route(async (req, res) => {
  res.json(await shiftService.listShifts(ownerIdOf(req), { page: pageParam(req) }));
});

const openShift = route(async (req, res) => {
  const shift = await shiftService.openShift(req.orderSettings);
  realtime.emit({ ownerId: ownerIdOf(req), event: "shift", staff: true });
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

// Cierre de turno (la caja se cierra aparte).
const closeShift = route(async (req, res) => {
  const shift = await shiftService.closeShift(ownerIdOf(req), {
    notes: cleanText(req.body?.notes, 300),
    force: req.body?.force === true,
  });
  realtime.emit({ ownerId: ownerIdOf(req), event: "shift", staff: true });
  res.json({ shift });
});

// ── Caja ─────────────────────────────────────

const listCashRegisters = route(async (req, res) => {
  res.json({ registers: await cashService.listRegisters(ownerIdOf(req)) });
});

const createCashRegister = route(async (req, res) => {
  res.status(201).json({ register: await cashService.createRegister(ownerIdOf(req), req.body) });
});

const updateCashRegister = route(async (req, res) => {
  res.json({ register: await cashService.updateRegister(ownerIdOf(req), idParam(req), req.body) });
});

// Cajas abiertas (con su resultado en vivo).
const listOpenCash = route(async (req, res) => {
  res.json({ sessions: await cashService.listOpenSessions(ownerIdOf(req)) });
});

// Todo lo de la pantalla de caja en una sola consulta.
const getCashOverview = route(async (req, res) => {
  res.json(await cashService.getOverview(ownerIdOf(req)));
});

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayParam = (value) => {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !DAY_RE.test(value) || Number.isNaN(Date.parse(value))) throw new OrdersError(400, "Fecha inválida.");
  return value;
};

// Cajas cerradas (?page=&register=&cashier=&result=exact|short|over|uncounted&from=&to=).
const listClosedCash = route(async (req, res) => {
  const { register, cashier, result, from, to } = req.query;
  res.json(await cashService.listClosedSessions(ownerIdOf(req), {
    page: pageParam(req),
    registerId: optionalPositiveInt(register, { field: "Caja" }),
    cashier: cleanText(cashier, LIMITS.cashierNameLength),
    result: result === undefined || result === "" ? null : result,
    from: dayParam(from),
    to: dayParam(to),
  }));
});

// ── Reportes ─────────────────────────────────

// Ventas del período para Estadísticas: mismas ventanas que las visitas
// (GET /api/users/me/stats), para que las dos pestañas hablen de los mismos días.
const getSalesReport = route(async (req, res) => {
  const { days, serviceType } = req.query;
  if (days !== "7" && days !== "30") throw new OrdersError(400, "El período debe ser de 7 o 30 días.");
  if (serviceType !== undefined && !SERVICE_TYPES.includes(serviceType)) throw new OrdersError(400, "Tipo de pedido inválido.");
  res.json(await reportService.salesDashboard(
    ownerIdOf(req), buildStatsPeriod(Number(days), req.user.createdAt), { serviceType: serviceType ?? null }
  ));
});

const getCashSession = route(async (req, res) => {
  res.json({ session: await cashService.getSession(ownerIdOf(req), idParam(req)) });
});

const openCash = route(async (req, res) => {
  const body = req.body ?? {};
  res.status(201).json({
    session: await cashService.openSession(ownerIdOf(req), {
      registerId: optionalPositiveInt(body.registerId, { field: "Caja" }),
      cashierId: body.cashierId,
      cashierName: body.cashierName,
      openingAmount: body.openingAmount,
    }, panelActor(req)),
  });
});

const updateCash = route(async (req, res) => {
  res.json({ session: await cashService.updateSession(ownerIdOf(req), idParam(req), req.body ?? {}, panelActor(req)) });
});

const closeCash = route(async (req, res) => {
  res.json({ session: await cashService.closeSession(ownerIdOf(req), idParam(req), req.body ?? {}, panelActor(req)) });
});

// Libro de una caja (?type=&cashOnly=1&page=).
const getCashLedger = route(async (req, res) => {
  const { type, cashOnly } = req.query;
  res.json(await cashService.getLedger(ownerIdOf(req), idParam(req), {
    type: type === undefined || type === "" ? null : type,
    cashOnly: cashOnly === "1" || cashOnly === "true",
    page: pageParam(req),
  }));
});

// Ingreso, egreso o retiro. Devuelve la caja con el resultado ya actualizado.
const addCashMovement = route(async (req, res) => {
  const result = await cashService.addMovement(ownerIdOf(req), idParam(req), req.body ?? {}, panelActor(req));
  res.status(result.duplicate ? 200 : 201).json(result);
});

const voidCashMovement = route(async (req, res) => {
  res.json(await cashService.voidMovement(ownerIdOf(req), idParam(req), req.body ?? {}, panelActor(req)));
});

// ── Operadores ───────────────────────────────

const listWaiters = route(async (req, res) => {
  res.json({ waiters: await waiterService.listWaiters(ownerIdOf(req)) });
});

const createWaiter = route(async (req, res) => {
  res.status(201).json({ waiter: await waiterService.createWaiter(ownerIdOf(req), req.body) });
});

const updateWaiter = route(async (req, res) => {
  const waiter = await waiterService.updateWaiter(ownerIdOf(req), idParam(req), req.body);
  notifyDevices(req);
  res.json({ waiter });
});

const deleteWaiter = route(async (req, res) => {
  await waiterService.deleteWaiter(ownerIdOf(req), idParam(req));
  notifyDevices(req);
  res.status(204).end();
});

const issuePairingCode = route(async (req, res) => {
  res.json(await waiterService.issuePairingCode(ownerIdOf(req), idParam(req)));
});

const listWaiterSessions = route(async (req, res) => {
  res.json({ sessions: await waiterService.listSessions(ownerIdOf(req), idParam(req)) });
});

const revokeWaiterSessions = route(async (req, res) => {
  await waiterService.revokeSessions(ownerIdOf(req), idParam(req));
  notifyDevices(req);
  res.status(204).end();
});

const revokeWaiterSession = route(async (req, res) => {
  await waiterService.revokeSession(ownerIdOf(req), idParam(req), idParam(req, "sessionId"));
  notifyDevices(req);
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
  dispatchOrder,
  removeOrderItem,
  restoreOrderItem,
  setOrderItemDelivered,
  assignOrderWaiter,
  listTableSessions,
  getTableSession,
  closeTableSession,
  updateTableSession,
  listShifts,
  openShift,
  getShiftSummary,
  closeShift,
  listCashRegisters,
  createCashRegister,
  updateCashRegister,
  getCashOverview,
  listOpenCash,
  listClosedCash,
  getCashLedger,
  addCashMovement,
  voidCashMovement,
  getSalesReport,
  getCashSession,
  openCash,
  updateCash,
  closeCash,
  listWaiters,
  createWaiter,
  updateWaiter,
  deleteWaiter,
  issuePairingCode,
  listWaiterSessions,
  revokeWaiterSessions,
  revokeWaiterSession,
};
