// Escapa caracteres especiales de regex antes de interpolar un string
// controlado por el usuario en un `new RegExp(...)` — sin esto, alguien
// podría mandar un patrón propio (ej. ".*") en vez de un literal.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = { escapeRegex };
