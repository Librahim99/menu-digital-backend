// ──────────────────────────────────────────────
// Migraciones SQL de Reservas. Mismo mecanismo que Gestión de pedidos
// (orders/db/migrate.js): aplica en orden los archivos de ./migrations que
// todavía no figuren en schema_migrations, cada uno en su transacción.
// Manual a propósito (no corre al levantar la API).
//
// Uso: npm run reservations:migrate
// ──────────────────────────────────────────────

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { getPool } = require("../../config/postgres");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
// Se prefija para no chocar con los nombres de las migraciones de pedidos
// (comparten la tabla schema_migrations).
const PREFIX = "reservas_";

const migrate = async () => {
  const pool = getPool();
  if (!pool) throw new Error("Falta DATABASE_URL: no hay base SQL a la que migrar.");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((row) => row.name));
  const pending = fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql") && !applied.has(PREFIX + file))
    .sort();

  if (pending.length === 0) {
    console.log("✅ Sin migraciones de reservas pendientes.");
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [PREFIX + file]);
      await client.query("COMMIT");
      console.log(`✅ Migración aplicada: ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Falló ${file}: ${error.message}`);
    } finally {
      client.release();
    }
  }
};

migrate()
  .catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => getPool()?.end());
