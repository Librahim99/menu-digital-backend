const { getConfig } = require("./config");
const { verifySignature } = require("./signature");
const { processPaymentNotification } = require("./webhookService");

// Notificaciones de Mercado Pago de pedidos online (público, sin JWT).
//
// Orden: firma → solo eventos de pago → procesar. Un 401 es una firma inválida;
// un 500 es un fallo transitorio nuestro o de MP (MP reintenta); todo lo demás
// responde 200 para que MP no siga reintentando lo que no nos corresponde.
const receive = async (req, res) => {
  const dataId = req.query["data.id"] || req.query.id;
  const check = verifySignature({ headers: req.headers, dataId, secret: getConfig().webhookSecret });
  if (!check.valid) {
    console.error(`[orders/payments] Webhook rechazado: ${check.reason}`);
    return res.status(401).json({ message: "Firma inválida" });
  }

  const topic = req.body?.type || req.query.type || req.query.topic;
  if (topic !== "payment") return res.status(200).json({ received: true, ignored: true });

  try {
    const { outcome } = await processPaymentNotification({
      mpUserId: req.body?.user_id,
      paymentId: String(dataId),
      requestId: req.headers["x-request-id"],
      topic,
    });
    return res.status(200).json({ received: true, outcome });
  } catch (error) {
    console.error("[orders/payments] Error procesando webhook:", error?.message);
    return res.status(500).json({ message: "No se pudo procesar la notificación" });
  }
};

module.exports = { receive };
