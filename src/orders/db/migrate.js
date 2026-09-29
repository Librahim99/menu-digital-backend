// ──────────────────────────────────────────────
// Migraciones SQL de Gestión de pedidos.
//
// Aplica en orden los archivos de ./migrations que todavía no figuren en
// schema_migrations, cada uno dentro de su propia transacción. Es manual a
// propósito (no corre al levantar la API): el esquema se cambia a
// conciencia y contra la base que apunta DATABASE_URL.
//
// Uso: npm run orders:migrate
// ──────────────────────────────────────────────

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { getPool } = require("../../config/postgres");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

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
    .filter((file) => file.endsWith(".sql") && !applied.has(file))
    .sort();

  if (pending.length === 0) {
    console.log("✅ Sin migraciones pendientes.");
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
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
