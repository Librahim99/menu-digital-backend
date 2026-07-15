const express = require("express");
const router = express.Router();
const { MercadoPagoConfig, Preference } = require("mercadopago");
const { protect } = require("../middleware/auth");
const { mpWebhook } = require("../controllers/paymentController");

// ── Inicializar cliente MP con el Access Token del .env
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// ── Mapeo de planes pagos: id → datos de cobro para MercadoPago.
// El id (starter/pro/premium) es el mismo que después viaja en
// metadata.plan_id y que el webhook mapea a User.subscription (ver
// PLAN_MAP en config/plans.js). "free" no está acá: no se paga.
const PLANES = {
  starter: {
    title: "Menú Digital — Plan Starter",
    unit_price: 5999,
    description: "Menú digital ilimitado, landing page del local, carga masiva por Excel",
  },
  pro: {
    title: "Menú Digital — Plan Pro",
    unit_price: 29999,
    description: "Todo el plan Starter + estadísticas de visitas",
  },
  premium: {
    title: "Menú Digital — Plan Premium",
    unit_price: 49999,
    description: "Todo el plan Pro + dominio personalizado",
  },
};

/**
 * POST /api/payments/crear-preferencia
 * @access  Private — el usuario ya tiene cuenta (plan gratis) y está
 *          mejorando a un plan pago desde adentro de la app. Por eso
 *          requiere estar logueado: así podemos guardar quién es el
 *          que paga (external_reference) y el webhook puede después
 *          actualizarle la suscripción a esa misma cuenta.
 * Body: { planId: "starter" | "pro" | "premium" }
 * Devuelve: { init_point: "https://..." }
 */
router.post("/crear-preferencia", protect, async (req, res) => {
  const { planId } = req.body;

  // Validar que el plan exista
  const plan = PLANES[planId];
  if (!plan) {
    return res.status(400).json({ error: `Plan inválido: ${planId}` });
  }

  try {
    const preference = new Preference(client);

    const result = await preference.create({
      body: {
        items: [
          {
            id: planId,
            title: plan.title,
            description: plan.description,
            quantity: 1,
            unit_price: plan.unit_price,
            currency_id: "ARS",
          },
        ],
        // Vuelve al panel (no a /register: el usuario ya tiene cuenta).
        // El query param es solo para que el front pueda mostrar un
        // mensaje — la fuente de verdad de si se acreditó el plan es
        // el webhook, no este redirect.
        back_urls: {
          success: `${process.env.FRONTEND_URL}/dashboard?payment=success`,
          failure: `${process.env.FRONTEND_URL}/dashboard?payment=failure`,
          pending: `${process.env.FRONTEND_URL}/dashboard?payment=pending`,
        },
        auto_return: "approved", // redirige automáticamente si el pago es aprobado
        // Identifica quién paga — lo lee mpWebhook para saber a qué
        // cuenta actualizarle la suscripción cuando MP confirme el pago.
        external_reference: req.user._id.toString(),
        metadata: {
          plan_id: planId,
        },
      },
    });

    // Devolver la URL de pago al frontend
    res.json({ init_point: result.init_point });
  } catch (error) {
    console.error("Error creando preferencia MP:", error);
    res.status(500).json({ error: "No se pudo crear la preferencia de pago" });
  }
});

/**
 * POST /api/payments/webhook
 * MercadoPago llama acá cuando cambia el estado de un pago.
 * @access  Public (lo llama MercadoPago, no el frontend)
 */
router.post("/webhook", mpWebhook);

module.exports = router;