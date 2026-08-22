const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { MercadoPagoConfig, Preference } = require("mercadopago");
const { protect } = require("../middleware/auth");
const { getRegistrationStatus, mpWebhook } = require("../controllers/paymentController");
const PendingRegistration = require("../models/PendingRegistration");
const User = require("../models/User");
const { PLAN_ORDER } = require("../config/plans");
const {
  decryptPendingPassword,
  encryptPendingPassword,
} = require("../utils/pendingCredentials");

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
    unit_price: 2000,
    description: "Hasta 50 productos, sin publicidad, Excel, programación, PDF y 5 diseños",
  },
  pro: {
    title: "Menú Digital — Plan Pro",
    unit_price: 5000,
    description: "Productos ilimitados, métricas, reseñas integradas, dominio propio y 15 diseños",
  },
};

// Multiplicadores por duración (descuento por pagar más meses)
const MONTH_MULTIPLIERS = {
  1: 1,
  3: 2.7,  // ~10% off
  6: 5,    // ~17% off
  12: 9,   // 25% off
};

const hashRegistrationToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const sameSecret = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const buildRegistrationPreference = ({
  pendingID,
  plan,
  planId,
  months,
  unitPrice,
  checkoutStartsAt,
  checkoutExpiresAt,
}) => ({
  items: [
    {
      id: planId,
      title: `${plan.title} — ${months} mes(es)`,
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
    pending: `${process.env.FRONTEND_URL}/register/success?payment=pending`,
  },
  auto_return: "approved",
  // La preferencia y los medios offline dejan de aceptar pagos al mismo
  // tiempo. PendingRegistration conserva un margen adicional para recibir
  // la acreditación y el webhook de pagos iniciados cerca del vencimiento.
  expires: true,
  expiration_date_from: checkoutStartsAt.toISOString(),
  expiration_date_to: checkoutExpiresAt.toISOString(),
  date_of_expiration: checkoutExpiresAt.toISOString(),
  external_reference: pendingID.toString(),
  metadata: {
    plan_id: planId,
    months,
    type: "registration",
  },
});

/**
 * POST /api/payments/crear-preferencia
 * @access  Private — el usuario ya tiene cuenta (plan gratis) y está
 *          mejorando a un plan pago desde adentro de la app. Por eso
 *          requiere estar logueado: así podemos guardar quién es el
 *          que paga (external_reference) y el webhook puede después
 *          actualizarle la suscripción a esa misma cuenta.
 * Body: { planId: "basic" | "pro", months: 1 | 3 | 6 | 12 }
 * Devuelve: { init_point: "https://..." }
 */
router.post("/crear-preferencia", protect, async (req, res) => {
  const { planId } = req.body;
  const months = Number(req.body.months);

  // Validar que el plan exista
  const plan = PLANES[planId];
  if (!plan) {
    return res.status(400).json({ error: `Plan inválido: ${planId}` });
  }
  if (![1, 3, 6, 12].includes(months)) {
    return res.status(400).json({ error: "Duración inválida. Opciones: 1, 3, 6 o 12 meses" });
  }
  if (PLAN_ORDER.indexOf(planId) < PLAN_ORDER.indexOf(req.user.subscription)) {
    return res.status(400).json({ error: "El plan elegido no puede ser inferior al plan actual" });
  }

  try {
    const preference = new Preference(client);
    const totalPrice = Math.round(plan.unit_price * MONTH_MULTIPLIERS[months]);
    const isRenewal = planId === req.user.subscription;
    const currentExpiry = new Date(req.user.subscriptionExpiresAt || 0);
    const renewalBase = isRenewal && !Number.isNaN(currentExpiry.getTime()) && currentExpiry > new Date()
      ? currentExpiry
      : new Date();

    const result = await preference.create({
      body: {
        items: [
          {
            id: planId,
            title: `${plan.title} — ${months} mes(es)`,
            description: plan.description,
            quantity: 1,
            unit_price: totalPrice,
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
          months,
          type: "upgrade",
          payment_mode: isRenewal ? "renewal" : "upgrade",
          ...(isRenewal && { renewal_base: renewalBase.toISOString() }),
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
  const {
    username,
    password,
    acceptedTerms,
    contactInfo,
    planId,
    months,
    registrationToken,
  } = req.body;

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

  if (
    registrationToken !== undefined &&
    (typeof registrationToken !== "string" || !/^[a-f0-9]{64}$/.test(registrationToken))
  ) {
    return res.status(400).json({ error: "Token de registro inválido" });
  }

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

    const now = new Date();
    let activationToken = registrationToken;
    let pending = null;

    // Retry de la misma pestaña: el token identifica exactamente el intento.
    if (activationToken) {
      pending = await PendingRegistration.findOne({
        activationTokenHash: hashRegistrationToken(activationToken),
        status: "pending",
        expiresAt: { $gt: now },
      }).select("+password +passwordCiphertext +passwordIV +passwordAuthTag");
    }

    // Si cerró la pestaña, sessionStorage desaparece. Recuperamos el intento
    // por identidad, pero solo si también conoce la misma contraseña.
    if (!pending) {
      const candidate = await PendingRegistration.findOne({
        status: "pending",
        expiresAt: { $gt: now },
        $or: [
          { username: cleanUsername },
          { "contactInfo.mail": cleanMail },
        ],
      })
        .select("+password +passwordCiphertext +passwordIV +passwordAuthTag")
        .sort({ createdAt: -1 });

      if (candidate) {
        const candidatePassword = decryptPendingPassword(candidate);
        const sameIdentity =
          candidate.username === cleanUsername &&
          candidate.contactInfo.mail === cleanMail &&
          sameSecret(candidatePassword, password);

        if (!sameIdentity) {
          return res.status(409).json({
            error: "Ya existe un intento de registro pendiente para ese usuario o email",
          });
        }

        pending = candidate;
        activationToken = crypto.randomBytes(32).toString("hex");
        pending.activationTokenHash = hashRegistrationToken(activationToken);
      }
    }

    if (pending) {
      const pendingPassword = decryptPendingPassword(pending);
      const sameIdentity =
        pending.username === cleanUsername &&
        pending.contactInfo.mail === cleanMail &&
        sameSecret(pendingPassword, password);

      if (!sameIdentity) {
        return res.status(409).json({ error: "Los datos no coinciden con el registro pendiente" });
      }
    } else {
      // Primer intento: todavía no existe un User. La contraseña se conserva
      // cifrada para poder crear la cuenta cuando MercadoPago apruebe.
      activationToken = crypto.randomBytes(32).toString("hex");
      const encryptedPassword = encryptPendingPassword(password);
      pending = new PendingRegistration({
        username: cleanUsername,
        ...encryptedPassword,
        contactInfo: {
          mail: cleanMail,
          businessName: cleanBusinessName,
        },
        acceptedTerms: true,
        planId,
        months: monthsNum,
        activationTokenHash: hashRegistrationToken(activationToken),
      });

      await pending.save();
    }

    if (!pending._id) {
      throw new Error("PendingRegistration se guardó sin generar un _id");
    }

    const unitPrice = Math.round(plan.unit_price * MONTH_MULTIPLIERS[monthsNum]);
    const checkoutStartsAt = new Date();
    const checkoutExpiresAt = PendingRegistration.getCheckoutExpiration(
      checkoutStartsAt.getTime()
    );
    const pendingExpiresAt = PendingRegistration.getPendingExpiration(
      checkoutStartsAt.getTime()
    );
    const preferenceBody = buildRegistrationPreference({
      pendingID: pending._id,
      plan,
      planId,
      months: monthsNum,
      unitPrice,
      checkoutStartsAt,
      checkoutExpiresAt,
    });
    const preference = new Preference(client);
    const wasReused = Boolean(pending.preferenceId);
    const result = wasReused
      ? await preference.update({
          id: pending.preferenceId,
          updatePreferenceRequest: preferenceBody,
          requestOptions: {
            idempotencyKey: `registration-${pending._id}-${planId}-${monthsNum}`,
          },
        })
      : await preference.create({
          body: preferenceBody,
          requestOptions: { idempotencyKey: `registration-${pending._id}` },
        });

    const initPoint = result.init_point || pending.initPoint;
    if (!initPoint) {
      throw new Error("MercadoPago no devolvió una URL de checkout");
    }

    pending.planId = planId;
    pending.months = monthsNum;
    pending.preferenceId = result.id || pending.preferenceId;
    pending.initPoint = initPoint;
    pending.expiresAt = pendingExpiresAt;
    await pending.save();

    res.json({
      init_point: initPoint,
      registrationToken: activationToken,
      reused: wasReused,
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
