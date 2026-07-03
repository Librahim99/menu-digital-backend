const CrmProfile = require("../models/CrmProfile");

// ──────────────────────────────────────────────
// Loguea un evento automático en el historial de CRM de un cliente (cambio
// de plan, activar/desactivar cuenta, cambio de template). Se llama desde
// los controllers que ya hacen esas acciones — nunca debe romper el flujo
// principal (pagar, activar, cambiar template) si el logueo falla, por eso
// atrapa su propio error en vez de dejarlo propagarse.
// ──────────────────────────────────────────────
const logCrmEvent = async (userID, text) => {
  try {
    await CrmProfile.findOneAndUpdate(
      { userID },
      { $push: { notes: { $each: [{ text, kind: "event", author: null }], $position: 0 } } },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error("No se pudo loguear evento de CRM:", err);
  }
};

module.exports = { logCrmEvent };
