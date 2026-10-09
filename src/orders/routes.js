// ──────────────────────────────────────────────
// Rutas de Gestión de pedidos — montadas en /api/orders (ver app.js).
//
//   /api/orders/public/:slug/*  carta pública (comensal en el local, sin sesión)
//   /api/orders/waiter/*        tomador de pedidos (dispositivo del operador)
//   /api/orders/courier/*       app del repartidor (dispositivo vinculado)
//   /api/orders/delivery/*      Delivery en el panel del local
//   /api/orders/station/*       pantalla de un sector (equipo vinculado con código)
//   /api/orders/*               panel del dueño (JWT + plan PRO)
//
// Todo este árbol usa Postgres (Neon); si no está configurado responde 503
// y el resto de la API no se entera.
// ──────────────────────────────────────────────

const express = require("express");
const rateLimit = require("express-rate-limit");
const { protect } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimiters");
const {
  requireOrdersDb, requireProPlan, loadSettings, protectWaiter, protectStation, protectCourier,
} = require("./middleware");
const courierApp = require("./delivery/courierController");
const delivery = require("./delivery/deliveryController");
const sectors = require("./controllers/sectorController");
const owner = require("./controllers/ownerController");
const publicOrders = require("./controllers/publicController");
const waiter = require("./controllers/waiterController");
const mpConnection = require("./payments/connectionController");
const onlinePayments = require("./payments/publicController");
const mpWebhook = require("./payments/webhookController");
const mpRefunds = require("./payments/refundController");

const router = express.Router();

// Pedidos de comensales: además de la espera por dispositivo que controla
// orderService, un tope por IP. Holgado a propósito: todas las mesas de un
// local suelen salir por el mismo wifi.
const customerOrderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiados pedidos seguidos. Esperá unos minutos o pedile al personal." },
});

// Checkouts online: más estricto que el pedido en el local (un pago real por
// intento, y cada intento crea una preferencia en Mercado Pago).
const onlineCheckoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiados intentos de pago. Esperá unos minutos e intentá de nuevo." },
});

// Código de entrega: tope por IP además del bloqueo por pedido que aplica el servicio.
const deliveryCodeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiados intentos. Esperá unos minutos e intentá de nuevo." },
});

router.use(requireOrdersDb);

// ── Carta pública ────────────────────────────
router.get("/public/:slug/context", publicOrders.getContext);
router.post("/public/:slug/orders", customerOrderLimiter, publicOrders.createCustomerOrder);
// Take away / delivery pagados online (sin QR del local).
router.get("/public/:slug/online-ordering", onlinePayments.getOnlineOrdering);
router.post("/public/:slug/online-checkout", onlineCheckoutLimiter, onlinePayments.createCheckout);
router.get("/public/:slug/online-checkout/:ref", onlinePayments.getCheckoutStatus);
// Envío del pedido: si ya salió y el código de entrega que le da al repartidor.
router.get("/public/:slug/online-checkout/:ref/delivery", delivery.customerDelivery);

// ── Tomador de pedidos (operadores) ──────────
router.post("/waiter/pair", authLimiter, waiter.pair);
router.get("/waiter/me", protectWaiter, waiter.me);
router.post("/waiter/logout", protectWaiter, waiter.logout);
router.get("/waiter/orders", protectWaiter, waiter.myOrders);
router.post("/waiter/orders", protectWaiter, waiter.createOrder);
router.get("/waiter/tables", protectWaiter, waiter.myTables);
router.patch("/waiter/tables/:id", protectWaiter, waiter.updateTable);
router.post("/waiter/tables/:id/close", protectWaiter, waiter.closeTable);
router.get("/waiter/history", protectWaiter, waiter.myHistory);

// ── Repartidores (dispositivo vinculado) ─────
router.post("/courier/pair", authLimiter, courierApp.pair);
router.get("/courier/me", protectCourier, courierApp.me);
router.post("/courier/logout", protectCourier, courierApp.logout);
router.put("/courier/availability", protectCourier, courierApp.setAvailability);
router.get("/courier/panel", protectCourier, courierApp.panel);
router.get("/courier/history", protectCourier, courierApp.history);
router.get("/courier/orders/:id", protectCourier, courierApp.getOrder);
router.post("/courier/orders/:id/claim", protectCourier, courierApp.claim);
router.post("/courier/orders/:id/pickup", protectCourier, courierApp.pickup);
router.post("/courier/orders/:id/deliver", protectCourier, deliveryCodeLimiter, courierApp.deliver);

// ── Pantalla de un sector (equipo vinculado) ──
router.post("/station/pair", authLimiter, sectors.pair);
router.get("/station/me", protectStation, sectors.me);
router.post("/station/logout", protectStation, sectors.logout);
router.get("/station/tickets", protectStation, sectors.stationTickets);
router.patch("/station/tickets/:id/status", protectStation, sectors.stationTicketStatus);
router.post("/station/tickets/:id/printed", protectStation, sectors.stationTicketPrinted);

// ── Panel del dueño ──────────────────────────
const ownerOnly = [protect, requireProPlan, loadSettings];

router.get("/settings", ownerOnly, owner.getSettings);
router.put("/settings", ownerOnly, owner.updateSettings);
router.post("/settings/regenerate-qr", ownerOnly, owner.regenerateQr);

// Pagos con Mercado Pago del local (cuenta propia, OAuth). El callback es
// público: lo invoca el navegador al volver de Mercado Pago.
router.get("/payments/oauth/callback", authLimiter, mpConnection.oauthCallback);
// Notificaciones de MP: la firma se valida adentro (no hay sesión).
router.post("/payments/webhook", mpWebhook.receive);
router.get("/payments/connection", ownerOnly, mpConnection.getConnection);
router.post("/payments/connection/start", ownerOnly, mpConnection.startConnection);
router.delete("/payments/connection", ownerOnly, mpConnection.disconnect);

router.get("/board", ownerOnly, owner.getBoard);
router.get("/orders", ownerOnly, owner.listOrders);
router.post("/orders", ownerOnly, owner.createOrder);
router.patch("/orders/:id/status", ownerOnly, owner.updateOrderStatus);
// Pago online del pedido y devoluciones desde el panel.
router.get("/orders/:id/payment", ownerOnly, mpRefunds.getOrderPayment);
router.post("/orders/:id/refund", ownerOnly, mpRefunds.requestRefund);
router.post("/orders/:id/refunds/:refundId/retry", ownerOnly, mpRefunds.retryRefund);
router.post("/orders/:id/dispatch", ownerOnly, owner.dispatchOrder);
router.patch("/orders/:id/waiter", ownerOnly, owner.assignOrderWaiter);
// Un producto del pedido: quitarlo (falta de stock…), restaurarlo o entregarlo antes que el resto.
router.post("/orders/:id/items/:itemId/remove", ownerOnly, owner.removeOrderItem);
router.post("/orders/:id/items/:itemId/restore", ownerOnly, owner.restoreOrderItem);
router.patch("/orders/:id/items/:itemId/delivered", ownerOnly, owner.setOrderItemDelivered);

// Delivery: entregas en curso, repartidores y auditoría. Las rutas no dependen del
// interruptor para poder consultar y resolver lo pendiente; cada operación que
// crea trabajo nuevo valida la configuración en el servicio.
router.get("/delivery/active", ownerOnly, delivery.listActive);
router.post("/delivery/orders/:id/assign", ownerOnly, delivery.assign);
router.post("/delivery/orders/:id/unassign", ownerOnly, delivery.unassign);
router.post("/delivery/orders/:id/complete", ownerOnly, delivery.complete);
router.get("/delivery/orders/:id/trail", ownerOnly, delivery.trail);
router.post("/delivery/orders/:id/code", ownerOnly, delivery.revealCode);
router.get("/delivery/couriers", ownerOnly, delivery.listCouriers);
router.post("/delivery/couriers", ownerOnly, delivery.createCourier);
router.put("/delivery/couriers/:id", ownerOnly, delivery.updateCourier);
router.delete("/delivery/couriers/:id", ownerOnly, delivery.deleteCourier);
router.post("/delivery/couriers/:id/pairing-code", ownerOnly, delivery.issuePairingCode);
router.delete("/delivery/couriers/:id/pairing-code", ownerOnly, delivery.revokePairingCode);
router.get("/delivery/couriers/:id/sessions", ownerOnly, delivery.listSessions);
router.delete("/delivery/couriers/:id/sessions", ownerOnly, delivery.revokeSessions);
router.delete("/delivery/couriers/:id/sessions/:sessionId", ownerOnly, delivery.revokeSession);

// Sesiones de mesa (?status=open|closed)
router.get("/table-sessions", ownerOnly, owner.listTableSessions);
router.get("/table-sessions/:id", ownerOnly, owner.getTableSession);
router.patch("/table-sessions/:id", ownerOnly, owner.updateTableSession);
router.post("/table-sessions/:id/close", ownerOnly, owner.closeTableSession);

// Turnos (el cierre de turno no cierra la caja)
router.get("/shifts", ownerOnly, owner.listShifts);
router.post("/shifts", ownerOnly, owner.openShift);
router.post("/shifts/current/close", ownerOnly, owner.closeShift);
// :id puede ser "current" (turno abierto) o el id de un turno.
router.get("/shifts/:id/summary", ownerOnly, owner.getShiftSummary);

// Caja (independiente del turno)
router.get("/cash/registers", ownerOnly, owner.listCashRegisters);
router.post("/cash/registers", ownerOnly, owner.createCashRegister);
router.put("/cash/registers/:id", ownerOnly, owner.updateCashRegister);
router.get("/cash/sessions/open", ownerOnly, owner.listOpenCash);
router.get("/cash/sessions", ownerOnly, owner.listClosedCash);
router.post("/cash/sessions", ownerOnly, owner.openCash);
router.get("/cash/sessions/:id", ownerOnly, owner.getCashSession);
router.patch("/cash/sessions/:id", ownerOnly, owner.updateCash);
router.post("/cash/sessions/:id/close", ownerOnly, owner.closeCash);

// Operadores (en la API siguen como "waiters")
router.get("/waiters", ownerOnly, owner.listWaiters);
router.post("/waiters", ownerOnly, owner.createWaiter);
router.put("/waiters/:id", ownerOnly, owner.updateWaiter);
router.delete("/waiters/:id", ownerOnly, owner.deleteWaiter);
router.post("/waiters/:id/pairing-code", ownerOnly, owner.issuePairingCode);
router.get("/waiters/:id/sessions", ownerOnly, owner.listWaiterSessions);
router.delete("/waiters/:id/sessions", ownerOnly, owner.revokeWaiterSessions);
router.delete("/waiters/:id/sessions/:sessionId", ownerOnly, owner.revokeWaiterSession);

// Sectores y comandas. /sectors/assignments antes de /sectors/:id.
router.get("/sectors", ownerOnly, sectors.listSectors);
router.post("/sectors", ownerOnly, sectors.createSector);
router.put("/sectors/assignments", ownerOnly, sectors.setAssignment);
router.put("/sectors/:id", ownerOnly, sectors.updateSector);
router.delete("/sectors/:id", ownerOnly, sectors.deleteSector);
router.post("/sectors/:id/pairing-code", ownerOnly, sectors.issuePairingCode);
router.delete("/sectors/:id/sessions", ownerOnly, sectors.revokeSessions);
router.delete("/sectors/:id/sessions/:sessionId", ownerOnly, sectors.revokeSession);
// El dueño puede usar la pantalla de cualquier sector desde su sesión.
router.get("/sectors/:id/tickets", ownerOnly, sectors.ownerTickets);
router.patch("/sectors/:id/tickets/:ticketId/status", ownerOnly, sectors.ownerTicketStatus);
router.post("/sectors/:id/tickets/:ticketId/printed", ownerOnly, sectors.ownerTicketPrinted);

module.exports = router;
