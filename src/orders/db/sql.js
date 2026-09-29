const { getPool } = require("../../config/postgres");
const { OrdersError } = require("../errors");

// Acceso a Postgres del módulo de pedidos. Reusa el pool de
// config/postgres.js (una sola conexión a Neon para toda la API).

const pool = () => {
  const current = getPool();
  if (!current) throw new OrdersError(503, "La gestión de pedidos no está disponible en este momento.");
  return current;
};

const query = (text, params) => pool().query(text, params);

// Corre `fn(client)` dentro de una transacción: COMMIT si termina bien,
// ROLLBACK si tira. `client.query` tiene la misma firma que `query`.
const withTransaction = async (fn) => {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { query, withTransaction };
