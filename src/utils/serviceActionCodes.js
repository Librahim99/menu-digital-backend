const crypto = require("crypto");
const PendingServiceAction = require("../models/PendingServiceAction");
// Se accede como `mailer.sendConfirmationCodeEmail` (no destructurado) para
// que los tests puedan mockear el envío reasignando la propiedad del módulo.
const mailer = require("./mailer");

// Helpers compartidos por todos los flujos que confirman una acción con un
// código de 6 dígitos mandado por email (baja, arrepentimiento,
// verificacion_email). Vivían duplicados dentro de paymentController.js;
// movidos acá para que userController.js (verificación de email post-alta)
// los reutilice sin repetir la lógica de generación/hash/expiración.
const generateNumericCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");
const hashCode = (code) => crypto.createHash("sha256").update(String(code)).digest("hex");
const maskEmail = (mail) => String(mail).replace(/^(.).*(@.*)$/, "$1***$2");

const createPendingServiceAction = async ({ action, userID, email, paymentID = null }) => {
  // Un pedido nuevo invalida cualquier código anterior sin usar para la misma acción.
  await PendingServiceAction.deleteMany({ action, userID, consumed: false });

  const code = generateNumericCode();
  const pending = await PendingServiceAction.create({
    action,
    userID,
    email,
    paymentID,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + PendingServiceAction.CODE_TTL_MS),
  });

  try {
    await mailer.sendConfirmationCodeEmail({ to: email, code, action });
  } catch (mailError) {
    await PendingServiceAction.deleteOne({ _id: pending._id });
    throw Object.assign(new Error("No se pudo enviar el email de confirmación"), {
      cause: mailError,
      isMailError: true,
    });
  }

  return pending;
};

// Busca el código pendiente, valida vencimiento/intentos y lo marca
// consumido de forma atómica (evita doble ejecución por doble click/retry).
//
// El pendiente se ubica por `requestId` (flujos públicos sin login: baja,
// arrepentimiento — el requestId es lo único que identifica el pedido) o por
// `userID` (flujos autenticados: verificacion_email — el JWT ya prueba quién
// es, no hace falta que el cliente guarde y reenvíe un requestId).
const claimPendingServiceAction = async ({ requestId, userID, code, action }) => {
  const pending = await PendingServiceAction.findOne({
    ...(requestId ? { _id: requestId } : { userID }),
    action,
    consumed: false,
    expiresAt: { $gt: new Date() },
  });

  if (!pending) {
    return { error: { status: 400, message: "El código venció o ya fue usado. Volvé a solicitarlo." } };
  }

  if (pending.attempts >= PendingServiceAction.MAX_ATTEMPTS) {
    await PendingServiceAction.updateOne({ _id: pending._id }, { $set: { consumed: true } });
    return { error: { status: 400, message: "Superaste el límite de intentos. Volvé a solicitarlo." } };
  }

  if (hashCode(code) !== pending.codeHash) {
    await PendingServiceAction.updateOne({ _id: pending._id }, { $inc: { attempts: 1 } });
    return { error: { status: 400, message: "El código ingresado no es correcto." } };
  }

  const claimed = await PendingServiceAction.findOneAndUpdate(
    { _id: pending._id, consumed: false },
    { $set: { consumed: true } },
    { new: true }
  );
  if (!claimed) {
    return { error: { status: 409, message: "Esta solicitud ya fue confirmada." } };
  }

  return { pending: claimed };
};

module.exports = {
  generateNumericCode,
  hashCode,
  maskEmail,
  createPendingServiceAction,
  claimPendingServiceAction,
};
