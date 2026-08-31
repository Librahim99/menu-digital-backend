const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { MercadoPagoConfig, Preference } = require("mercadopago");
const { protect } = require("../middleware/auth");
const { getRegistrationStatus, mpWebhook } = require("../controllers/paymentController");
const PendingRegistration = require("../models/PendingRegistration");
const PaymentCheckout = require("../models/PaymentCheckout");
const User = require("../models/User");
const { PLAN_ORDER } = require("../config/plans");
const {
  PAYMENT_CURRENCY,
  VALID_PAYMENT_MONTHS,
} = require("../config/paymentPlans");
const catalog = require("../services/planCatalog");
const { handleError } = require("../utils/handleError");
const {
  decryptPendingPassword,
  encryptPendingPassword,
} = require("../utils/pendingCredentials");

// Cada operación recibe su propia configuración: el SDK muta `options`
// al aplicar requestOptions y una instancia global puede heredar la clave
// de idempotencia usada por otro checkout.
const createPreferenceClient = () =>
  new Preference(
    new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN })
  );

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
  checkoutID,
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
      currency_id: PAYMENT_CURRENCY,
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
    checkout_id: checkoutID.toString(),
  },
});

/**
 * POST /api/payments/crear-preferencia
 * @access  Private — el usuario ya tiene cuenta (plan gratis) y está
 *          mejorando a un plan pago desde adentro de la app. Por eso
 *          requiere estar logueado: así podemos guardar quién es el
 *          que paga (external_reference) y el webhook puede después
 *          actualizarle la suscripción a esa misma cuenta.
 * Body: { planId: "basic" | "pro", months: 1 | 3 | 6 | 12, planVersion: number }
 * Devuelve: { init_point: "https://..." }
 */
router.post("/crear-preferencia", protect, async (req, res) => {
  const { planId } = req.body;
  const months = Number(req.body.months);

  // Validar que el plan exista
  if (!["basic", "pro"].includes(planId)) {
    return res.status(400).json({ error: `Plan inválido: ${planId}` });
  }
  if (!VALID_PAYMENT_MONTHS.includes(months)) {
    return res.status(400).json({ error: "Duración inválida. Opciones: 1, 3, 6 o 12 meses" });
  }
  if (PLAN_ORDER.indexOf(planId) < PLAN_ORDER.indexOf(req.user.subscription)) {
    return res.status(400).json({ error: "El plan elegido no puede ser inferior al plan actual" });
  }

  let checkout = null;
  try {
    const plan = await catalog.getCheckoutQuote(planId, months);
    if (!Number.isSafeInteger(req.body.planVersion) || req.body.planVersion !== plan.version) {
      return res.status(409).json({ code: "PLAN_PRICE_CHANGED", error: "El plan cambió. Revisá los precios y beneficios actualizados antes de confirmar." });
    }
    const preference = createPreferenceClient();
    const totalPrice = plan.total;
    const isRenewal = planId === req.user.subscription;
    const currentExpiry = new Date(req.user.subscriptionExpiresAt || 0);
    const renewalBase = isRenewal && !Number.isNaN(currentExpiry.getTime()) && currentExpiry > new Date()
      ? currentExpiry
      : new Date();
    checkout = await PaymentCheckout.create({
      operation: isRenewal ? "renewal" : "upgrade",
      userID: req.user._id,
      planId,
      months,
      expectedAmount: totalPrice,
      planVersion: plan.version,
      currency: PAYMENT_CURRENCY,
      sourcePlan: req.user.subscription,
      sourceExpiresAt: req.user.subscriptionExpiresAt || null,
    });

    const result = await preference.create({
      body: {
        items: [
          {
            id: planId,
            title: `${plan.title} — ${months} mes(es)`,
            description: plan.description,
            quantity: 1,
            unit_price: totalPrice,
            currency_id: PAYMENT_CURRENCY,
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
          checkout_id: checkout._id.toString(),
          ...(isRenewal && { renewal_base: renewalBase.toISOString() }),
        },
      },
      requestOptions: { idempotencyKey: `subscription-${checkout._id}` },
    });
    if (!result?.id || !result?.init_point) {
      throw new Error("MercadoPago no devolvió una preferencia de checkout completa");
    }

    const readyCheckout = await PaymentCheckout.findByIdAndUpdate(
      checkout._id,
      {
        $set: {
          preferenceId: result.id,
          initPoint: result.init_point,
          status: "ready",
          failureReason: null,
        },
      },
      { new: true, runValidators: true }
    );
    if (!readyCheckout) {
      throw new Error("El checkout desapareció después de crear la preferencia");
    }

    // Devolver la URL de pago al frontend
    res.json({ init_point: result.init_point });
  } catch (error) {
    if (error.code === "PLAN_CATALOG_UNAVAILABLE") return handleError(res, error);
    if (checkout?._id) {
      try {
        await PaymentCheckout.findByIdAndUpdate(checkout._id, {
          $set: { status: "failed", failureReason: error.message },
        });
      } catch (checkoutError) {
        console.error("Error marcando checkout fallido:", checkoutError);
      }
    }
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
 *   months: 1 | 3 | 6 | 12, planVersion: number
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

  if (!["basic", "pro"].includes(planId)) {
    return res.status(400).json({ error: `Plan inválido: ${planId}` });
  }

  const monthsNum = Number(months);
  if (!VALID_PAYMENT_MONTHS.includes(monthsNum)) {
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

  const paymentDebugID = crypto.randomUUID();
  let paymentDebugStage = "request_validated";
  console.log("[MP registro] solicitud validada", {
    paymentDebugID,
    planId,
    months: monthsNum,
    acceptedTermsIsTrue: acceptedTerms === true,
    hasRegistrationToken: Boolean(registrationToken),
  });

  try {
    paymentDebugStage = "checking_plan_catalog";
    const plan = await catalog.getCheckoutQuote(planId, monthsNum);
    if (!Number.isSafeInteger(req.body.planVersion) || req.body.planVersion !== plan.version) {
      return res.status(409).json({ code: "PLAN_PRICE_CHANGED", error: "El plan cambió. Revisá los precios y beneficios actualizados antes de confirmar." });
    }
    // Username o email ya usados
    paymentDebugStage = "checking_existing_user";
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
      paymentDebugStage = "finding_pending_by_token";
      pending = await PendingRegistration.findOne({
        activationTokenHash: hashRegistrationToken(activationToken),
        status: "pending",
        expiresAt: { $gt: now },
      }).select("+password +passwordCiphertext +passwordIV +passwordAuthTag");
    }

    // Si cerró la pestaña, sessionStorage desaparece. Recuperamos el intento
    // por identidad, pero solo si también conoce la misma contraseña.
    if (!pending) {
      paymentDebugStage = "finding_pending_by_identity";
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

      paymentDebugStage = "saving_new_pending";
      await pending.save();
    }

    if (!pending._id) {
      throw new Error("PendingRegistration se guardó sin generar un _id");
    }

    console.log("[MP registro] registro pendiente listo", {
      paymentDebugID,
      pendingRegistrationID: String(pending._id),
      status: pending.status,
      hasCheckoutID: Boolean(pending.checkoutID),
      hasPreferenceID: Boolean(pending.preferenceId),
      hasInitPoint: Boolean(pending.initPoint),
    });

    paymentDebugStage = "preparing_checkout";
    const unitPrice = plan.total;
    const checkoutStartsAt = new Date();
    const checkoutExpiresAt = PendingRegistration.getCheckoutExpiration(
      checkoutStartsAt.getTime()
    );
    const pendingExpiresAt = PendingRegistration.getPendingExpiration(
      checkoutStartsAt.getTime()
    );
    paymentDebugStage = "loading_previous_checkout";
    const previousCheckout = pending.checkoutID
      ? await PaymentCheckout.findById(pending.checkoutID)
      : null;
    const canReuseCheckout = Boolean(
      previousCheckout
      && previousCheckout.status === "ready"
      && previousCheckout.planId === planId
      && previousCheckout.months === monthsNum
      && previousCheckout.planVersion === plan.version
      && previousCheckout.expectedAmount === unitPrice
      && previousCheckout.currency === PAYMENT_CURRENCY
      && pending.preferenceId
      && pending.initPoint
    );
    paymentDebugStage = "persisting_checkout";
    console.log("[MP registro] checkout antes de persistir", {
      paymentDebugID,
      pendingRegistrationID: String(pending._id),
      hasPreviousCheckout: Boolean(previousCheckout),
      canReuseCheckout,
      operation: "registration",
      planId,
      months: monthsNum,
      expectedAmount: unitPrice,
      currency: PAYMENT_CURRENCY,
      sourcePlanProvided: false,
      sourcePlanSchemaDefault:
        PaymentCheckout.schema.path("sourcePlan")?.defaultValue,
    });
    const checkout = canReuseCheckout
      ? previousCheckout
      : await PaymentCheckout.create({
          operation: "registration",
          pendingRegistrationID: pending._id,
          planId,
          months: monthsNum,
          expectedAmount: unitPrice,
          planVersion: plan.version,
          currency: PAYMENT_CURRENCY,
        });
    console.log("[MP registro] checkout listo", {
      paymentDebugID,
      checkoutID: String(checkout._id),
      status: checkout.status,
      reused: canReuseCheckout,
      sourcePlan: checkout.sourcePlan,
    });
    if (!canReuseCheckout && previousCheckout?._id) {
      paymentDebugStage = "superseding_previous_checkout";
      await PaymentCheckout.findByIdAndUpdate(previousCheckout._id, {
        $set: { status: "superseded" },
      });
    }

    const preferenceBody = buildRegistrationPreference({
      pendingID: pending._id,
      checkoutID: checkout._id,
      plan,
      planId,
      months: monthsNum,
      unitPrice,
      checkoutStartsAt,
      checkoutExpiresAt,
    });
    const preference = createPreferenceClient();
    const wasReused = canReuseCheckout;
    let result;
    let preferenceId;
    let initPoint;
    try {
      paymentDebugStage = wasReused
        ? "updating_mercadopago_preference"
        : "creating_mercadopago_preference";
      console.log("[MP registro] llamada a MercadoPago", {
        paymentDebugID,
        checkoutID: String(checkout._id),
        action: wasReused ? "update" : "create",
        hasWebhookUrl: Boolean(process.env.MP_WEBHOOK_URL),
        hasFrontendUrl: Boolean(process.env.FRONTEND_URL),
      });
      result = wasReused
        ? await preference.update({
            id: pending.preferenceId,
            updatePreferenceRequest: preferenceBody,
            requestOptions: {
              idempotencyKey: `registration-update-${paymentDebugID}`,
            },
          })
        : await preference.create({
            body: preferenceBody,
            requestOptions: { idempotencyKey: `registration-${checkout._id}` },
          });
      preferenceId = wasReused
        ? result?.id || pending.preferenceId
        : result?.id;
      initPoint = wasReused
        ? result?.init_point || pending.initPoint
        : result?.init_point;
      console.log("[MP registro] respuesta de MercadoPago", {
        paymentDebugID,
        checkoutID: String(checkout._id),
        hasResponsePreferenceID: Boolean(result?.id),
        hasResponseInitPoint: Boolean(result?.init_point),
        hasStoredPreferenceID: Boolean(pending.preferenceId),
        hasStoredInitPoint: Boolean(pending.initPoint),
        responsePreferenceMatchesStored: Boolean(
          result?.id && pending.preferenceId && result.id === pending.preferenceId
        ),
        responseInitPointMatchesStored: Boolean(
          result?.init_point
          && pending.initPoint
          && result.init_point === pending.initPoint
        ),
      });
      if (!preferenceId || !initPoint) {
        throw new Error("MercadoPago no devolvió una preferencia de checkout completa");
      }
    } catch (error) {
      if (!wasReused) {
        paymentDebugStage = "marking_checkout_failed";
        await PaymentCheckout.findByIdAndUpdate(checkout._id, {
          $set: { status: "failed", failureReason: error.message },
        });
      }
      throw error;
    }

    pending.planId = planId;
    pending.months = monthsNum;
    pending.preferenceId = preferenceId;
    pending.initPoint = initPoint;
    pending.checkoutID = checkout._id;
    pending.expiresAt = pendingExpiresAt;
    paymentDebugStage = "saving_pending_checkout";
    await pending.save();
    console.log("[MP registro] registro pendiente actualizado", {
      paymentDebugID,
      pendingRegistrationID: String(pending._id),
      checkoutID: String(checkout._id),
      hasPreferenceID: Boolean(pending.preferenceId),
      hasInitPoint: Boolean(pending.initPoint),
    });

    paymentDebugStage = "marking_checkout_ready";
    const readyCheckout = await PaymentCheckout.findByIdAndUpdate(
      checkout._id,
      {
        $set: {
          preferenceId: pending.preferenceId,
          initPoint,
          status: "ready",
          failureReason: null,
        },
      },
      { new: true, runValidators: true }
    );
    if (!readyCheckout) {
      throw new Error("El checkout desapareció después de crear la preferencia");
    }

    console.log("[MP registro] preferencia preparada", {
      paymentDebugID,
      pendingRegistrationID: String(pending._id),
      checkoutID: String(readyCheckout._id),
      checkoutStatus: readyCheckout.status,
    });

    paymentDebugStage = "completed";
    res.json({
      init_point: initPoint,
      registrationToken: activationToken,
      reused: wasReused,
    });
  } catch (error) {
    if (error.code === "PLAN_CATALOG_UNAVAILABLE") return handleError(res, error);
    console.error("[MP registro] diagnóstico estructurado", {
      paymentDebugID,
      stage: paymentDebugStage,
      name: error?.name,
      message: error?.message,
      planId,
      months: monthsNum,
      hasRegistrationToken: Boolean(registrationToken),
      validationErrors: Object.entries(error?.errors || {}).map(
        ([path, detail]) => ({
          path,
          kind: detail?.kind,
          isNull: detail?.value === null,
        })
      ),
    });
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
