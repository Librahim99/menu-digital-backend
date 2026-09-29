// ──────────────────────────────────────────────
// Rutas de Gestión de pedidos — montadas en /api/orders (ver app.js).
//
//   /api/orders/public/:slug/*  carta pública (comensal en el local, sin sesión)
//   /api/orders/waiter/*        tomador de pedidos (dispositivo del mozo)
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
  message: { message: "Demasiados pedidos seguidos. Esperá unos minutos o pedile al mozo." },
});

router.use(requireOrdersDb);

// ── Carta pública ────────────────────────────
router.get("/public/:slug/context", publicOrders.getContext);
router.post("/public/:slug/orders", customerOrderLimiter, publicOrders.createCustomerOrder);

// ── Tomador de pedidos (mozos) ───────────────
router.post("/waiter/pair", authLimiter, waiter.pair);
router.get("/waiter/me", protectWaiter, waiter.me);
router.post("/waiter/logout", protectWaiter, waiter.logout);
router.get("/waiter/orders", protectWaiter, waiter.myOrders);
router.post("/waiter/orders", protectWaiter, waiter.createOrder);

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

router.get("/shifts", ownerOnly, owner.listShifts);
router.post("/shifts", ownerOnly, owner.openShift);
router.post("/shifts/current/close", ownerOnly, owner.closeShift);
// :id puede ser "current" (turno abierto) o el id de un turno.
router.get("/shifts/:id/summary", ownerOnly, owner.getShiftSummary);

router.get("/waiters", ownerOnly, owner.listWaiters);
router.post("/waiters", ownerOnly, owner.createWaiter);
router.put("/waiters/:id", ownerOnly, owner.updateWaiter);
router.delete("/waiters/:id", ownerOnly, owner.deleteWaiter);
router.post("/waiters/:id/pairing-code", ownerOnly, owner.issuePairingCode);
router.delete("/waiters/:id/sessions", ownerOnly, owner.revokeWaiterSessions);

module.exports = router;
