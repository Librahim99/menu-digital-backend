const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { MercadoPagoConfig, Preference } = require("mercadopago");
const { protect } = require("../middleware/auth");
const { getRegistrationStatus, mpWebhook } = require("../controllers/paymentController");
const PendingRegistration = require("../models/PendingRegistration");
const User = require("../models/User");

// ── Inicializar cliente MP con el Access Token del .env
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// ── Mapeo de planes pagos: id → datos de cobro para MercadoPago.
// El id (basic/pro) es el mismo que después viaja en
// metadata.plan_id y que el webhook mapea a User.subscription (ver
// PLAN_MAP en config/plans.js). "free" no está acá: no se paga.
const PLANES = {
  basic: {
    title: "Menú Digital — Plan Basic",
    unit_price: 5999,
    description: "Menú digital ilimitado, landing page del local, carga masiva por Excel",
  },
  pro: {
    title: "Menú Digital — Plan Pro",
    unit_price: 29999,
    description: "Todo el plan basic + estadísticas de visitas + dominio personalizado",
  },
};

// Multiplicadores por duración (descuento por pagar más meses)
const MONTH_MULTIPLIERS = {
  1: 1,
  3: 2.7,  // ~10% off
  6: 5,    // ~17% off
  12: 9,   // 25% off
};

/**
 * POST /api/payments/crear-preferencia
 * @access  Private — el usuario ya tiene cuenta (plan gratis) y está
 *          mejorando a un plan pago desde adentro de la app. Por eso
 *          requiere estar logueado: así podemos guardar quién es el
 *          que paga (external_reference) y el webhook puede después
 *          actualizarle la suscripción a esa misma cuenta.
 * Body: { planId: "basic" | "pro" }
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

        notification_url: process.env.MP_WEBHOOK_URL,
        
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
          type: "upgrade",
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
 * POST /api/payments/crear-preferencia-registro
 * @access  Public — el usuario todavía no tiene cuenta. Guarda los datos
 *          en PendingRegistration y crea la preferencia de MP. El webhook
 *          crea el User cuando el pago se aprueba.
 * Body: {
 *   username, password, acceptedTerms,
 *   contactInfo: { mail, businessName },
 *   planId: "basic" | "pro",
 *   months: 1 | 3 | 6 | 12
 * }
 * Devuelve: { init_point: "https://..." }
 */
router.post("/crear-preferencia-registro", async (req, res) => {
  const { username, password, acceptedTerms, contactInfo, planId, months } = req.body;

  // --- Validaciones ---
  if (
    !username ||
    !password ||
    !acceptedTerms ||
    !contactInfo?.mail ||
    !contactInfo?.businessName
  ) {
    return res.status(400).json({ error: "Faltan datos de registro" });
  }

  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres" });
  }

  const plan = PLANES[planId];
  if (!plan) {
    return res.status(400).json({ error: `Plan inválido: ${planId}` });
  }

  const monthsNum = Number(months);
  if (![1, 3, 6, 12].includes(monthsNum)) {
    return res.status(400).json({ error: "Duración inválida. Opciones: 1, 3, 6 o 12 meses" });
  }

  const cleanUsername = String(username).trim();
  const cleanMail = String(contactInfo.mail).trim().toLowerCase();
  const cleanBusinessName = String(contactInfo.businessName).trim();

  try {
    // Username o email ya usados
    const existing = await User.findOne({
      $or: [
        { username: cleanUsername },
        { "contactInfo.mail": cleanMail },
      ],
    });
    if (existing) {
      return res.status(409).json({ error: "Usuario o email ya registrado" });
    }

    // Crear pending (password en plain; el pre-save de User la hashea al crear)
    const activationToken = crypto.randomBytes(32).toString("hex");
    const activationTokenHash = crypto
      .createHash("sha256")
      .update(activationToken)
      .digest("hex");

    const pending = new PendingRegistration({
      username: cleanUsername,
      password,
      contactInfo: {
        mail: cleanMail,
        businessName: cleanBusinessName,
      },
      acceptedTerms: true,
      planId,
      months: monthsNum,
      activationTokenHash,
    });

    await pending.save();

    if (!pending._id) {
      throw new Error("PendingRegistration se guardó sin generar un _id");
    }

    const unitPrice = Math.round(plan.unit_price * MONTH_MULTIPLIERS[monthsNum]);

    const preference = new Preference(client);
    const result = await preference.create({
      body: {
        items: [
          {
            id: planId,
            title: `${plan.title} — ${monthsNum} mes(es)`,
            description: plan.description,
            quantity: 1,
            unit_price: unitPrice,
            currency_id: "ARS",
          },
        ],

        notification_url: process.env.MP_WEBHOOK_URL,

        back_urls: {
          success: `${process.env.FRONTEND_URL}/register/success`,
          failure: `${process.env.FRONTEND_URL}/register/plans?payment=failure`,
          pending: `${process.env.FRONTEND_URL}/register/plans?payment=pending`,
        },
        auto_return: "approved",
        // external_reference = id del PendingRegistration
        // el webhook lo usa para crear el User cuando el pago se aprueba
        external_reference: pending._id.toString(),
        metadata: {
          plan_id: planId,
          months: monthsNum,
          type: "registration", // o "registration" si es registro nuevo
        },
      },
    });

    res.json({
      init_point: result.init_point,
      registrationToken: activationToken,
    });
  } catch (error) {
    console.error("Error creando preferencia de registro:", error);
    res.status(500).json({ error: "No se pudo crear la preferencia de pago" });
  }
});

// El frontend consulta este endpoint al volver de MercadoPago. El token es
// aleatorio y solo permite conocer si este registro puntual ya fue activado.
router.post("/registro/estado", getRegistrationStatus);

/**
 * POST /api/payments/webhook
 * MercadoPago llama acá cuando cambia el estado de un pago.
 * @access  Public (lo llama MercadoPago, no el frontend)
 */
router.post("/webhook", mpWebhook);

module.exports = router;
