// ──────────────────────────────────────────────
// Rutas de Reservas — montadas en /api/reservations (ver app.js).
//
//   /api/reservations/public/:slug/*   landing del local (cliente sin cuenta)
//   /api/reservations/*                panel del dueño (JWT + plan PRO)
//   /api/reservations/ws               WebSocket (ver realtime.js)
//
// Las reservas viven en Postgres (Neon); si no está configurado responde 503
// y el resto de la API no se entera.
// ──────────────────────────────────────────────

const express = require("express");
const rateLimit = require("express-rate-limit");
const { protect } = require("../middleware/auth");
const { getPool } = require("../config/postgres");
const publicReservations = require("./controllers/publicController");
const owner = require("./controllers/ownerController");

const router = express.Router();

// Crear reservas: tope por IP (una reserva real son pocas por persona).
const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Hiciste muchas reservas seguidas. Esperá unos minutos o escribinos por WhatsApp." },
});

// Consultar por código: el límite frena adivinar códigos (31^8 combinaciones).
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiadas consultas. Esperá unos minutos e intentá de nuevo." },
});

const requireReservationsDb = (req, res, next) => {
  if (!getPool()) {
    return res.status(503).json({ message: "Las reservas no están disponibles en este momento." });
  }
  next();
};

// Después de protect: las reservas son exclusivas del plan PRO vigente.
const requireProPlan = (req, res, next) => {
  if (req.user?.subscription !== "pro") {
    return res.status(403).json({
      code: "FEATURE_NOT_INCLUDED",
      feature: "reservas",
      message: "Las reservas están disponibles en el plan Pro.",
    });
  }
  next();
};

router.use(requireReservationsDb);

// ── Landing (cliente) ────────────────────────
router.get("/public/:slug/config", publicReservations.getConfig);
router.post("/public/:slug/reservations", createLimiter, publicReservations.createReservation);
router.get("/public/:slug/reservations/:code", lookupLimiter, publicReservations.getReservation);
router.post("/public/:slug/reservations/:code/accept-alternative", lookupLimiter, publicReservations.acceptAlternative);
router.post("/public/:slug/reservations/:code/cancel", lookupLimiter, publicReservations.cancelReservation);

// ── Panel del dueño ──────────────────────────
const ownerOnly = [protect, requireProPlan];

router.get("/settings", ownerOnly, owner.getSettings);
router.put("/settings", ownerOnly, owner.updateSettings);

router.get("/", ownerOnly, owner.listReservations);
router.post("/", ownerOnly, owner.createReservation);
router.patch("/:id", ownerOnly, owner.updateReservation);
// confirm | reject | cancel | complete | no-show | reopen
router.post("/:id/:action", ownerOnly, owner.doAction);

module.exports = router;
