const express = require("express");
const router = express.Router();
const { MercadoPagoConfig, Preference } = require("mercadopago");

// ── Inicializar cliente MP con el Access Token del .env
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// ── Mapeo de planes: id → datos
const PLANES = {
  mensual: {
    title: "Menú Digital — Plan Mensual",
    unit_price: 4999,
    description: "Menú digital ilimitado, landing page del local, carga masiva por Excel",
  },
  semestral: {
    title: "Menú Digital — Plan Semestral",
    unit_price: 24999,
    description: "Todo el plan mensual + 2 meses gratis + estadísticas",
  },
  anual: {
    title: "Menú Digital — Plan Anual",
    unit_price: 39999,
    description: "Todo el plan semestral + 4 meses gratis + dominio personalizado",
  },
};

/**
 * POST /api/payments/crear-preferencia
 * Body: { planId: "mensual" | "semestral" | "anual" }
 * Devuelve: { init_point: "https://..." }
 */
router.post("/crear-preferencia", async (req, res) => {
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
        // URLs de redirección después del pago
        back_urls: {
        success: `${process.env.FRONTEND_URL}/register`,
        failure: `${process.env.FRONTEND_URL}/register?from=mp_failure`, 
        pending: `${process.env.FRONTEND_URL}/register`,
        },
        auto_return: "approved", // redirige automáticamente si el pago es aprobado
        // Datos extra para identificar el pago en webhooks futuros
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

module.exports = router;