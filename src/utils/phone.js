// Teléfonos argentinos: se guardan como código de área + número local, 10
// dígitos, sin 54, sin el 9 de celular, sin el 0 de discado ni el 15
// (ej. "1123456789"). El link de WhatsApp se arma en el front agregando
// "549" (ver sanitizePhoneForWa en menu-digital-frontend/src/lib/whatsapp.ts,
// que repite esta misma normalización para los números ya guardados).
//
// normalizeArPhone acepta lo que la gente suele tipear y lo lleva a ese
// formato: "+54 9 11 2345-6789", "54 11 2345 6789", "011 2345-6789",
// "11 15 2345-6789" → "1123456789". Si no se reconoce la forma, devuelve
// los dígitos tal cual (el caller decide si los acepta).
const LOCAL_LENGTH = 10;

const normalizeArPhone = (value) => {
  if (typeof value !== "number" && typeof value !== "string") return "";
  let digits = String(value).replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2); // prefijo internacional
  // Código de país. Ningún código de área argentino empieza con 54, así que
  // con 12 o más dígitos el 54 inicial es siempre el país.
  if (digits.startsWith("54") && digits.length >= LOCAL_LENGTH + 2) {
    digits = digits.slice(2);
    if (digits.startsWith("9") && digits.length === LOCAL_LENGTH + 1) digits = digits.slice(1);
  }
  if (digits.startsWith("0")) digits = digits.slice(1);
  // "15" de celular después del código de área (2, 3 o 4 dígitos): se
  // reconoce porque sobran exactamente esos dos dígitos.
  if (digits.length === LOCAL_LENGTH + 2) {
    for (const areaLength of [2, 3, 4]) {
      if (digits.slice(areaLength, areaLength + 2) === "15") {
        digits = digits.slice(0, areaLength) + digits.slice(areaLength + 2);
        break;
      }
    }
  }
  return digits;
};

const isValidArLocalPhone = (digits) =>
  typeof digits === "string" && new RegExp(`^[1-9]\\d{${LOCAL_LENGTH - 1}}$`).test(digits);

// contactInfo.number es Number en el schema: normaliza y lo deja listo para
// guardar (null si no quedan dígitos).
const toStoredPhone = (value) => {
  const digits = normalizeArPhone(value);
  return digits ? Number(digits) : null;
};

module.exports = { normalizeArPhone, isValidArLocalPhone, toStoredPhone };
