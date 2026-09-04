// Mismo patrón que ya usa el frontend (Regret.tsx/Unsubscribe.tsx) para
// validar el campo en el formulario. Única fuente de verdad acá: antes de
// esto, tanto el alta gratuita como la paga aceptaban cualquier string no
// vacío en contactInfo.mail (ver PENDIENTES.md) — una cuenta con basura ahí
// (ej. "ididid") rompía en silencio el envío del código de confirmación de
// baja/arrepentimiento, entre otros usos futuros del email de contacto.
const isValidEmail = (value) =>
  typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

module.exports = { isValidEmail };
