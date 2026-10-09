// Verificación de la firma (x-signature) de las notificaciones de Mercado Pago.
//
// Manifest documentado por MP: "id:<data.id en minúsculas>;request-id:<x-request-id>;ts:<ts>;"
// firmado con HMAC-SHA256 usando la clave secreta de la aplicación de MP de
// pedidos (MP_ORDERS_WEBHOOK_SECRET). Es otra aplicación y otro secreto que
// los de las suscripciones.
//
// Nunca se loguea el hash esperado ni el manifest: solo el motivo del rechazo.

const crypto = require("crypto");

const parseSignature = (header) => {
  const parts = {};
  for (const part of String(header ?? "").split(",")) {
    const index = part.indexOf("=");
    if (index > 0) parts[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return { ts: parts.ts, hash: parts.v1 };
};

// Si pasó por Envoy, el nibble de versión del request-id puede venir cambiado
// (4 → 9, a o b). Se prueba también con el original.
const requestIdCandidates = (requestId) => {
  const candidates = [requestId];
  const match = typeof requestId === "string"
    ? requestId.match(/^([0-9a-f]{8}-[0-9a-f]{4}-)[9ab]([0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i)
    : null;
  if (match) candidates.push(`${match[1]}4${match[2]}`);
  return candidates;
};

/**
 * @returns {{ valid: boolean, reason?: string }}
 */
const verifySignature = ({ headers = {}, dataId, secret }) => {
  if (!secret) return { valid: false, reason: "secret_missing" };
  const requestId = headers["x-request-id"];
  const { ts, hash } = parseSignature(headers["x-signature"]);
  if (!requestId || !dataId || !ts || !hash) return { valid: false, reason: "missing_data" };

  const received = Buffer.from(hash);
  const valid = requestIdCandidates(requestId).some((candidate) => {
    const manifest = `id:${String(dataId).toLowerCase()};request-id:${candidate};ts:${ts};`;
    const expected = Buffer.from(crypto.createHmac("sha256", secret).update(manifest).digest("hex"));
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  });
  return valid ? { valid: true } : { valid: false, reason: "mismatch" };
};

module.exports = { verifySignature };
