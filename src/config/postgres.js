const { Pool } = require("pg");

let pool = null;

const getPool = () => {
  if (!process.env.DATABASE_URL) return null;

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    // Neon corta conexiones inactivas cuando la branch se suspende
    // (scale-to-zero). Sin este handler, ese error tira abajo el proceso.
    pool.on("error", (error) => {
      console.error(`⚠️  Postgres (pool): ${error.message}`);
    });
  }

  return pool;
};

const connectPostgres = async () => {
  const db = getPool();

  if (!db) {
    console.warn("⚠️  DATABASE_URL no configurada: Postgres (Neon) deshabilitado.");
    return false;
  }

  try {
    const { rows } = await db.query("select current_database() as name");
    console.log(`✅ Postgres conectado: ${rows[0].name}`);
    return true;
  } catch (error) {
    // No hacemos process.exit: Neon es de prueba y no debe frenar la API.
    console.error(`❌ Error al conectar Postgres: ${error.message}`);
    return false;
  }
};

const query = (text, params) => {
  const db = getPool();
  if (!db) throw new Error("Postgres no configurado (falta DATABASE_URL)");
  return db.query(text, params);
};

module.exports = { connectPostgres, getPool, query };