const crypto = require("crypto");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const User = require("../models/User");
const PendingRegistration = require("../models/PendingRegistration"); 
const { PLAN_MAP, getEffectivePlan } = require("../config/plans");
const { logCrmEvent } = require("../utils/crmEvents");
const { addCalendarMonths } = require("../utils/dates");
const { handleError } = require("../utils/handleError");
const { generateAuthToken } = require("../utils/authToken");
const { generateSlug } = require("../utils/slug");


const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// ──────────────────────────────────────────────
// Verifica que el webhook realmente venga de MercadoPago, no de cualquiera
// que le pegue al endpoint. MP manda un header "x-signature" con
// "ts=<timestamp>,v1=<hash>", donde hash = HMAC-SHA256(manifest, secret) y
// el secret es la "Clave secreta" que configurás en tu panel de MP
// (Tus integraciones → la app → Webhooks). Algoritmo documentado acá:
// https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks#editor_2
//
// Si todavía no configuraste MP_WEBHOOK_SECRET en el .env, esto NO bloquea
// el webhook (para no cortar pagos reales de un día para el otro) — pero
// avisa por consola en cada request hasta que lo configures.
// ──────────────────────────────────────────────
const verifyMpSignature = (req) => {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("⚠️  MP_WEBHOOK_SECRET no configurado — el webhook de MP no está validando firma.");
    return true;
  }

  const xSignature = req.headers["x-signature"];
  const xRequestId = req.headers["x-request-id"];
  const dataId = req.query["data.id"];
  if (!xSignature || !xRequestId || !dataId) return false;

  let ts, hash;
  xSignature.split(",").forEach((part) => {
    const [key, value] = part.split("=");
    if (key?.trim() === "ts") ts = value?.trim();
    if (key?.trim() === "v1") hash = value?.trim();
  });
  if (!ts || !hash) return false;

  const manifest = `id:${dataId.toLowerCase()};request-id:${xRequestId};ts:${ts};`;
  const expectedHash = crypto.createHmac("sha256", secret).update(manifest).digest("hex");

  // timingSafeEqual evita que un atacante pueda ir adivinando el hash
  // byte a byte midiendo cuánto tarda en responder cada intento.
  const a = Buffer.from(hash);
  const b = Buffer.from(expectedHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// @desc    Consultar si el webhook ya completó un alta paga
// @route   POST /api/payments/registro/estado
// @access  Public, protegido por un token aleatorio de un solo registro
const getRegistrationStatus = async (req, res) => {
  try {
    const { registrationToken } = req.body;
    if (
      typeof registrationToken !== "string" ||
      !/^[a-f0-9]{64}$/.test(registrationToken)
    ) {
      return res.status(400).json({ message: "Token de registro inválido" });
    }

    const activationTokenHash = crypto
      .createHash("sha256")
      .update(registrationToken)
      .digest("hex");
    const pending = await PendingRegistration.findOne({ activationTokenHash })
      .select("status userID paymentStatus paymentStatusDetail");

    if (!pending) {
      return res.status(404).json({ message: "Registro no encontrado o vencido" });
    }

    if (pending.status !== "completed") {
      return res.json({
        status: pending.status,
        paymentStatus: pending.paymentStatus,
        paymentStatusDetail: pending.paymentStatusDetail,
      });
    }

    const user = await User.findById(pending.userID)
      .select("username admin slug subscription subscriptionExpiresAt active");
    if (!user) {
      throw new Error("El registro figura completo pero no tiene un usuario asociado");
    }
    if (!user.active) {
      return res.status(403).json({ message: "Cuenta desactivada" });
    }

    res.json({
      status: "completed",
      auth: {
        _id: user._id,
        username: user.username,
        admin: user.admin,
        slug: user.slug,
        subscription: getEffectivePlan(user.subscription, user.subscriptionExpiresAt),
        subscriptionExpiresAt: user.subscriptionExpiresAt,
        token: generateAuthToken(user._id),
      },
    });
  } catch (error) {
    handleError(res, error);
  }
};

// @desc    Recibe la notificación de MercadoPago y confirma el pago
// @route   POST /api/payments/webhook
// @access  Public (lo llama MercadoPago, no el frontend)
const mpWebhook = async (req, res) => {
  try {
    if (!verifyMpSignature(req)) {
      console.error("Webhook MP: firma inválida");
      return res.sendStatus(401);
    }

    const paymentId = req.query["data.id"] || req.query.id || req.body?.data?.id;
    const topic = req.query.type || req.query.topic;

    if (topic !== "payment" || !paymentId) {
      return res.sendStatus(200);
    }

    const payment = new Payment(client);
    const paymentData = await payment.get({ id: paymentId });

    const externalRef = paymentData.external_reference;
    const planId = paymentData.metadata?.plan_id;
    const mappedPlan = PLAN_MAP[planId];
    const isRegistration = paymentData.metadata?.type === "registration";
    const paymentUpdatedAtCandidate = new Date(
      paymentData.date_last_updated || Date.now()
    );
    const paymentSnapshot = {
      paymentID: String(paymentData.id || paymentId),
      paymentStatus: paymentData.status,
      paymentStatusDetail: paymentData.status_detail || null,
      paymentUpdatedAt: Number.isNaN(paymentUpdatedAtCandidate.getTime())
        ? new Date()
        : paymentUpdatedAtCandidate,
    };

    if (paymentData.status !== "approved") {
      if (isRegistration && externalRef) {
        // Solo actualizamos altas todavía pendientes: una notificación
        // rechazada que llegue tarde nunca debe pisar un pago ya completado.
        await PendingRegistration.findOneAndUpdate(
          { _id: externalRef, status: "pending" },
          { $set: paymentSnapshot }
        );
      }
      return res.sendStatus(200);
    }

    if (!externalRef || !mappedPlan) {
      console.error("Webhook MP: falta external_reference o plan_id inválido", {
        externalRef,
        planId,
      });
      return res.sendStatus(200);
    }

    // ── Flujo REGISTRO ──
    if (isRegistration) {
      const pending = await PendingRegistration.findById(externalRef);
      if (!pending) {
        // Ya se procesó o expiró
        return res.sendStatus(200);
      }

      if (pending.status === "completed" || pending.status === "failed") {
        return res.sendStatus(200);
      }

      // Evitar duplicados si MP reintenta el webhook
      const alreadyExists = await User.findOne({ username: pending.username })
        .select("+password");
      if (alreadyExists) {
        const belongsToThisRegistration = pending.password &&
          await alreadyExists.matchPassword(pending.password);
        await PendingRegistration.findByIdAndUpdate(pending._id, {
          $set: {
            status: belongsToThisRegistration ? "completed" : "failed",
            userID: belongsToThisRegistration ? alreadyExists._id : null,
            completedAt: belongsToThisRegistration ? new Date() : null,
            expiresAt: PendingRegistration.getTerminalExpiration(),
            ...paymentSnapshot,
          },
          $unset: { password: 1 },
        });
        return res.sendStatus(200);
      }

      const approvedAtCandidate = new Date(paymentData.date_approved || Date.now());
      const approvedAt = Number.isNaN(approvedAtCandidate.getTime())
        ? new Date()
        : approvedAtCandidate;
      const metadataMonths = Number(paymentData.metadata?.months);
      const paidMonths = [1, 3, 6, 12].includes(metadataMonths)
        ? metadataMonths
        : pending.months;
      const subscriptionExpiresAt = addCalendarMonths(approvedAt, paidMonths);

      const user = await User.create({
        username: pending.username,
        password: pending.password, // pre-save de User la hashea
        contactInfo: pending.contactInfo,
        slug: generateSlug(pending.contactInfo.businessName) || undefined,
        acceptedTerms: true,
        acceptedTermsAt: new Date(),
        acceptedTermsVersion: process.env.ACCEPTED_TERMS_VERSION,
        subscription: mappedPlan,
        subscriptionExpiresAt,
      });

      await PendingRegistration.findByIdAndUpdate(pending._id, {
        $set: {
          status: "completed",
          userID: user._id,
          planId: mappedPlan,
          months: paidMonths,
          completedAt: new Date(),
          expiresAt: PendingRegistration.getTerminalExpiration(),
          ...paymentSnapshot,
        },
        $unset: { password: 1 },
      });
      await logCrmEvent(
        user._id,
        `Alta por pago MP — plan ${mappedPlan} × ${paidMonths} mes(es), vigente hasta ${subscriptionExpiresAt.toISOString()}`
      );

      return res.sendStatus(200);
    }

    // ── Flujo UPGRADE (usuario ya existente) ──
    const rawUpgradeMonths = paymentData.metadata?.months;
    const metadataMonths = rawUpgradeMonths === undefined
      ? 1 // Preferencias de upgrade creadas antes de incorporar el selector.
      : Number(rawUpgradeMonths);
    if (![1, 3, 6, 12].includes(metadataMonths)) {
      console.error("Webhook MP: duración de upgrade inválida", {
        externalRef,
        planId,
        months: paymentData.metadata?.months,
      });
      return res.sendStatus(200);
    }

    const approvedAtCandidate = new Date(paymentData.date_approved || Date.now());
    const approvedAt = Number.isNaN(approvedAtCandidate.getTime())
      ? new Date()
      : approvedAtCandidate;
    const previousUser = await User.findById(externalRef).select("subscription subscriptionExpiresAt");
    if (!previousUser) return res.sendStatus(200);

    const isRenewal = paymentData.metadata?.payment_mode === "renewal"
      && previousUser.subscription === mappedPlan;
    const renewalBaseCandidate = new Date(paymentData.metadata?.renewal_base || "");
    const expiryBase = isRenewal
      && !Number.isNaN(renewalBaseCandidate.getTime())
      && renewalBaseCandidate > approvedAt
      ? renewalBaseCandidate
      : approvedAt;
    const subscriptionExpiresAt = addCalendarMonths(expiryBase, metadataMonths);

    await User.findByIdAndUpdate(externalRef, {
      subscription: mappedPlan,
      subscriptionExpiresAt,
    });

    await logCrmEvent(
      externalRef,
      `Pago MP aprobado — ${isRenewal ? `renovación ${mappedPlan}` : `plan ${previousUser.subscription} → ${mappedPlan}`} × ${metadataMonths} mes(es), vigente hasta ${subscriptionExpiresAt.toISOString()}`
    );

    res.sendStatus(200);
  } catch (error) {
    // Un 2xx confirma a MercadoPago que la notificación se procesó. Si la
    // API de MP o MongoDB fallan transitoriamente, debemos responder 500 para
    // que MercadoPago reintente el webhook y no quede un pago aprobado sin
    // crear/actualizar su usuario.
    handleError(res, error);
  }
};

module.exports = { getRegistrationStatus, mpWebhook };
