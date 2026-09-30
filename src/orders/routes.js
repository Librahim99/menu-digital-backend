// ──────────────────────────────────────────────
// Rutas de Gestión de pedidos — montadas en /api/orders (ver app.js).
//
//   /api/orders/public/:slug/*  carta pública (comensal en el local, sin sesión)
//   /api/orders/waiter/*        tomador de pedidos (dispositivo del operador)
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
  requireOrdersDb, requireProPlan, loadSettings, protectWaiter,
} = require("./middleware");
const owner = require("./controllers/ownerController");
const publicOrders = require("./controllers/publicController");
const waiter = require("./controllers/waiterController");

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

router.use(requireOrdersDb);

// ── Carta pública ────────────────────────────
router.get("/public/:slug/context", publicOrders.getContext);
router.post("/public/:slug/orders", customerOrderLimiter, publicOrders.createCustomerOrder);

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

// ── Panel del dueño ──────────────────────────
const ownerOnly = [protect, requireProPlan, loadSettings];

router.get("/settings", ownerOnly, owner.getSettings);
router.put("/settings", ownerOnly, owner.updateSettings);
router.post("/settings/regenerate-qr", ownerOnly, owner.regenerateQr);

router.get("/board", ownerOnly, owner.getBoard);
router.get("/orders", ownerOnly, owner.listOrders);
router.post("/orders", ownerOnly, owner.createOrder);
router.patch("/orders/:id/status", ownerOnly, owner.updateOrderStatus);
router.patch("/orders/:id/waiter", ownerOnly, owner.assignOrderWaiter);

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

module.exports = router;
