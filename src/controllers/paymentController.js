const { MercadoPagoConfig, Payment } = require("mercadopago");
const User = require("../models/User");
const { PLAN_MAP } = require("../config/plans");

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// @desc    Recibe la notificación de MercadoPago y confirma el pago
// @route   POST /api/payments/webhook
// @access  Public (lo llama MercadoPago, no el frontend)
const mpWebhook = async (req, res) => {
  try {
    const paymentId = req.query["data.id"] || req.query.id || req.body?.data?.id;
    const topic = req.query.type || req.query.topic;

    // Solo nos interesan eventos de tipo "payment"; respondemos 200 al resto
    // para que MP no reintente notificaciones que no vamos a procesar.
    if (topic !== "payment" || !paymentId) {
      return res.sendStatus(200);
    }

    // Verificamos el estado REAL contra la API de MP (nunca confiar en el query string)
    const payment = new Payment(client);
    const paymentData = await payment.get({ id: paymentId });

    if (paymentData.status !== "approved") {
      return res.sendStatus(200);
    }

    const userId  = paymentData.external_reference;
    const planId  = paymentData.metadata?.plan_id;
    const mappedPlan = PLAN_MAP[planId];

    if (!userId || !mappedPlan) {
      console.error("Webhook MP: falta external_reference o plan_id inválido", { userId, planId });
      return res.sendStatus(200);
    }

    await User.findByIdAndUpdate(userId, { subscription: mappedPlan });

    res.sendStatus(200);
  } catch (error) {
    console.error("Error en webhook de MP:", error);
    res.sendStatus(200); // 200 igual, para evitar reintentos infinitos de MP en errores no recuperables
  }
};

module.exports = { mpWebhook };