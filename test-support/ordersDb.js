// Base SQL en memoria para probar el módulo de pedidos con SQL de verdad.
//
// Levanta un Postgres embebido (PGlite), le aplica las migraciones reales de
// src/orders/db/migrations y lo pone en el lugar del pool de Neon. Así los
// tests ejercitan las consultas, los UNIQUE, los CHECK y los triggers tal como
// corren en producción, sin tocar Neon ni necesitar DATABASE_URL.
//
// Lo que viene de Mongo (el local y los precios del menú) se reemplaza por un
// catálogo de mentira: ver fakeCatalog.
//
// PGlite es una sola conexión: las transacciones corren de a una, en el orden
// en que llegan (lo mismo que consiguen los bloqueos FOR UPDATE en la base
// real). Alcanza para probar que dos operaciones "a la vez" no duplican nada.
//
// Uso:
//   const db = await startOrdersDb(t, { catalog: fakeCatalog({ owners, products }) });
//   const billService = db.load("services/billService");

const fs = require("fs");
const path = require("path");

const ORDERS_DIR = path.join(__dirname, "..", "src", "orders");
const MIGRATIONS_DIR = path.join(ORDERS_DIR, "db", "migrations");

// node-postgres devuelve bigint y numeric como texto: se respeta acá.
const PARSERS = { 20: (value) => value, 1700: (value) => value };

const createPool = (db) => {
  let tail = Promise.resolve();
  // Turno exclusivo sobre la única conexión.
  const acquire = () => {
    let release;
    const previous = tail;
    tail = new Promise((resolve) => { release = resolve; });
    return previous.then(() => release);
  };
  const run = async (text, params) => {
    const result = await db.query(text, params ?? [], { parsers: PARSERS });
    return { rows: result.rows, rowCount: result.affectedRows > 0 ? result.affectedRows : result.rows.length };
  };
  return {
    query: async (text, params) => {
      const release = await acquire();
      try {
        return await run(text, params);
      } finally {
        release();
      }
    },
    connect: async () => {
      const release = await acquire();
      let released = false;
      return { query: run, release: () => { if (!released) { released = true; release(); } } };
    },
  };
};

const purgeOrdersModules = () => {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ORDERS_DIR)) delete require.cache[key];
  }
};

const stubModule = (file, exports) => {
  const resolved = require.resolve(file);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
  return resolved;
};

/**
 * Catálogo de mentira en lugar de services/menuCatalog (Mongo).
 * @param {object} input
 * @param {Array<{_id, slug, active?, pro?}>} input.owners
 * @param {Record<string, {title, price, options?: Record<string, number>, available?: boolean}>} input.products  por itemId
 */
const fakeCatalog = ({ owners = [], products = {} }) => {
  // Se pide al tirar: startOrdersDb recarga los módulos de pedidos, y el error
  // tiene que ser de la misma clase que usan las rutas (instanceof).
  const fail = (message) => new (require(path.join(ORDERS_DIR, "errors")).OrdersError)(400, message);
  const isProOwner = (owner) => owner.pro !== false;
  return {
    isProOwner,
    findProOwnerBySlug: async (slug) => owners.find((o) => o.slug === slug && o.active !== false && isProOwner(o)) ?? null,
    findOwnerById: async (id) => owners.find((o) => String(o._id) === String(id)) ?? null,
    businessNameOf: (owner) => owner?.slug ?? "",
    priceOrderLines: async (owner, lines) => {
      const priced = lines.map((line, position) => {
        const product = products[line.itemId];
        if (!product) throw fail("Uno de los productos ya no está en el menú. Actualizá la carta e intentá de nuevo.");
        if (product.available === false) throw fail(`"${product.title}" no está disponible en este momento.`);
        if (line.option && !(product.options && line.option in product.options)) {
          throw fail(`La variante "${line.option}" de "${product.title}" ya no existe.`);
        }
        return {
          itemId: line.itemId, title: product.title, categoryId: null, categoryName: null, sectionId: null,
          option: line.option ?? null, unitPrice: line.option ? product.options[line.option] : product.price,
          quantity: line.quantity, notes: line.notes ?? null, position,
        };
      });
      const total = Math.round(priced.reduce((sum, line) => sum + line.unitPrice * line.quantity * 100, 0)) / 100;
      return { lines: priced, total };
    },
  };
};

/**
 * @param {object} t  contexto del test (o del archivo): al terminar se cierra la base
 * @param {{ catalog?: object }} options
 */
const startOrdersDb = async (t, { catalog = fakeCatalog({}) } = {}) => {
  const { PGlite } = require("@electric-sql/pglite");
  const db = new PGlite();
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }

  const pool = createPool(db);
  const postgres = require("../src/config/postgres");
  const originalGetPool = postgres.getPool;
  postgres.getPool = () => pool;
  // Los módulos de pedidos toman getPool y el catálogo al cargarse: se recargan.
  purgeOrdersModules();
  stubModule(path.join(ORDERS_DIR, "services", "menuCatalog.js"), catalog);

  const realtime = require(path.join(ORDERS_DIR, "delivery", "realtime"));
  const emitted = [];
  realtime.emit = (event) => { emitted.push(event); };

  const close = async () => {
    postgres.getPool = originalGetPool;
    purgeOrdersModules();
    await db.close();
  };
  t?.after?.(close);

  return {
    pool,
    emitted,
    close,
    query: (text, params) => pool.query(text, params),
    // Módulo de src/orders ya conectado a esta base (ej. "services/billService").
    load: (name) => require(path.join(ORDERS_DIR, name)),
  };
};

module.exports = { startOrdersDb, fakeCatalog, stubModule };
