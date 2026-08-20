const crypto = require("crypto");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const User = require("../models/User");
const PendingRegistration = require("../models/PendingRegistration"); 
const { PLAN_MAP } = require("../config/plans");
const { logCrmEvent } = require("../utils/crmEvents");


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

    if (paymentData.status !== "approved") {
      return res.sendStatus(200);
    }

    const externalRef = paymentData.external_reference;
    const planId = paymentData.metadata?.plan_id;
    const mappedPlan = PLAN_MAP[planId];
    const isRegistration = paymentData.metadata?.type === "registration";

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

      // Evitar duplicados si MP reintenta el webhook
      const alreadyExists = await User.findOne({ username: pending.username });
      if (alreadyExists) {
        await PendingRegistration.findByIdAndDelete(pending._id);
        return res.sendStatus(200);
      }

      const user = await User.create({
        username: pending.username,
        password: pending.password, // pre-save de User la hashea
        contactInfo: pending.contactInfo,
        acceptedTerms: true,
        subscription: mappedPlan,
        // opcional: subscriptionExpiresAt
      });

      await PendingRegistration.findByIdAndDelete(pending._id);
      await logCrmEvent(
        user._id,
        `Alta por pago MP — plan ${mappedPlan} × ${pending.months} mes(es)`
      );

      return res.sendStatus(200);
    }

    // ── Flujo UPGRADE (usuario ya existente) ──
    const previousUser = await User.findById(externalRef).select("subscription");
    await User.findByIdAndUpdate(externalRef, { subscription: mappedPlan });

    if (previousUser && previousUser.subscription !== mappedPlan) {
      await logCrmEvent(
        externalRef,
        `Cambió de plan ${previousUser.subscription} → ${mappedPlan} (pago MercadoPago aprobado)`
      );
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Error en webhook de MP:", error);
    res.sendStatus(200);
  }
};

module.exports = { mpWebhook };