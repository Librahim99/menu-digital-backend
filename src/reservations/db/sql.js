const { getPool } = require("../../config/postgres");
const { ReservationsError } = require("../errors");

// Acceso a Postgres del módulo de reservas. Reusa el pool de
// config/postgres.js (una sola conexión a Neon para toda la API).

const pool = () => {
  const current = getPool();
  if (!current) throw new ReservationsError(503, "Las reservas no están disponibles en este momento.");
  return current;
};

const query = (text, params) => pool().query(text, params);

module.exports = { query };
