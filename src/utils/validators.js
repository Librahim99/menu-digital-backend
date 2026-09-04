// Mismo patrón que ya usa el frontend (Regret.tsx/Unsubscribe.tsx) para
// validar el campo en el formulario. Única fuente de verdad acá: antes de
// esto, tanto el alta gratuita como la paga aceptaban cualquier string no
// vacío en contactInfo.mail (ver PENDIENTES.md) — una cuenta con basura ahí
// (ej. "ididid") rompía en silencio el envío del código de confirmación de
// baja/arrepentimiento, entre otros usos futuros del email de contacto.
const isValidEmail = (value) =>
  typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// Antes vivía solo en userController.js (alta gratuita) — el alta paga
// (POST /crear-preferencia-registro) tenía su propio chequeo, más débil,
// de solo longitud (ver PENDIENTES.md). Única fuente de verdad acá para que
// las dos altas exijan lo mismo. Solo longitud + una lista chica de las más
// triviales — no pedimos mayúscula/número/símbolo obligatorio: esa regla de
// "complejidad" está desaconsejada desde NIST 800-63B, porque en la
// práctica termina en patrones predecibles (ej. "Contraseña1!") en vez de
// contraseñas más fuertes. Lo que de verdad ayuda es longitud + no ser una
// de las contraseñas más usadas/filtradas.
const COMMON_WEAK_PASSWORDS = new Set([
  "12345678", "123456789", "1234567890", "password", "password1",
  "qwertyui", "qwerty123", "11111111", "00000000", "abc12345",
  "contraseña", "contrasena", "argentina", "administrador",
]);

const isWeakPassword = (password) =>
  typeof password !== "string"
  || password.length < 8
  || COMMON_WEAK_PASSWORDS.has(password.toLowerCase());

module.exports = { isValidEmail, isWeakPassword };
