// ──────────────────────────────────────────────
// Rutas de Juegos para comensales — montadas en /api/games (ver app.js).
//
//   /api/games/public/:slug   carta pública (comensal, sin cuenta)
//   /api/games/settings       configuración del dueño (JWT + plan con juegos)
//   /api/games/ws             WebSocket del Duelo de la carta (ver realtime.js)
//
// La configuración vive en MongoDB, con el resto de la del local: este módulo
// no depende de Postgres ni del módulo de pedidos.
// ──────────────────────────────────────────────

const express = require("express");
const { protect } = require("../middleware/auth");
const games = require("./controller");

const router = express.Router();

// Después de protect: los juegos son parte del plan Pro vigente (protect ya
// dejó en req.user.subscription el plan efectivo). Ver catalog.hasGames.
const requireGamesPlan = (req, res, next) => {
  if (req.user?.subscription !== "pro") {
    return res.status(403).json({
      code: "FEATURE_NOT_INCLUDED",
      feature: "juegos",
      message: "Los juegos para comensales están disponibles en el plan Pro.",
    });
  }
  next();
};

router.get("/public/:slug", games.getPublic);

const ownerOnly = [protect, requireGamesPlan];
router.get("/settings", ownerOnly, games.getSettings);
router.put("/settings", ownerOnly, games.updateSettings);

module.exports = router;
