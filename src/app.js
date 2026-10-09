const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");
const connectPostgres = require("./config/postgres").connectPostgres;

require("dotenv").config();

const connectDB = require("./config/db");
const { validateEnvironment } = require("./config/environment");
const { handleError } = require("./utils/handleError");
const { apiLimiter } = require("./middleware/rateLimiters");
const { getSitemap } = require("./controllers/sitemapController");
const { initializePlans } = require("./services/planCatalog");


// ──────────────────────────────────────────────
// Validación de configuración
// ──────────────────────────────────────────────

validateEnvironment();


// ──────────────────────────────────────────────
// App
// ──────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 5000;


// ──────────────────────────────────────────────
// Proxy
// ──────────────────────────────────────────────
//
// Detrás de un proxy/balanceador (Koyeb), Express
// recibe la IP del proxy. Esto permite que
// express-rate-limit pueda identificar correctamente
// la IP real del cliente.
//

app.set("trust proxy", 1);


// ──────────────────────────────────────────────
// Security headers
// ──────────────────────────────────────────────

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: "cross-origin",
    },
  })
);


// ──────────────────────────────────────────────
// CORS
// ──────────────────────────────────────────────

app.use(
  cors({
    origin: [
      "https://www.menudigitalapp.com.ar",
      "http://localhost:5173",
      "http://localhost:3000",
    ],
    credentials: true,
    methods: [
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "PATCH",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],
  })
);


// ──────────────────────────────────────────────
// Body parsing
// ──────────────────────────────────────────────

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true,
  })
);


// ──────────────────────────────────────────────
// NoSQL injection protection
// ──────────────────────────────────────────────
//
// Sanitizamos las rutas que trabajan directamente
// con datos que pueden terminar en consultas MongoDB.
//
// /api/payments queda fuera porque Mercado Pago
// utiliza parámetros como "data.id" en sus webhooks.
// Ese endpoint debe validar específicamente los
// datos recibidos de Mercado Pago.
//

app.use(
  [
    "/api/users",
    "/api/menus",
    "/api/items",
    "/api/admin",
    "/api/massive",
    "/api/sellers",
    "/api/menu-templates",
  ],
  mongoSanitize()
);


// ──────────────────────────────────────────────
// General API rate limit
// ──────────────────────────────────────────────
//
// Todos los endpoints bajo /api quedan protegidos
// por el rate limiter general.
//
// Los endpoints sensibles, como login/registro,
// pueden aplicar además un limiter específico.
//

app.use("/api", apiLimiter);


// ──────────────────────────────────────────────
// Rutas de la API
// ──────────────────────────────────────────────
//
// Las rutas específicas deben ir antes de las rutas
// generales para evitar que una ruta dinámica las
// intercepte.
//
// Ejemplo:
// /api/admin/payments
// debe registrarse antes de:
// /api/admin
//

app.use(
  "/api/admin/payments",
  require("./routes/adminPaymentRoutes")
);

app.use(
  "/api/admin/plans",
  require("./routes/adminPlanRoutes")
);

app.use(
  "/api/admin/push",
  require("./routes/adminPushRoutes")
);

app.use(
  "/api/admin/notifications",
  require("./routes/adminNotificationRoutes")
);

app.use(
  "/api/admin/sellers",
  require("./routes/sellerRoutes")
);

app.use(
  "/api/plans",
  require("./routes/planRoutes")
);

app.use(
  "/api/admin",
  require("./routes/adminRoutes")
);


// ──────────────────────────────────────────────
// CRM
// ──────────────────────────────────────────────
//
// El CRM lo utilizan tanto administradores como
// vendedores sobre sus propios clientes.
//
// /api/sellers/crm debe montarse antes de:
// /api/sellers
//
// para evitar que una ruta general intercepte
// las rutas específicas del CRM.
//

app.use(
  "/api/sellers/crm",
  require("./routes/crmRoutes")
);

app.use(
  "/api/sellers",
  require("./routes/sellerPanelRoutes")
);


// ──────────────────────────────────────────────
// Users
// ──────────────────────────────────────────────

app.use(
  "/api/users",
  require("./routes/userRoutes")
);


// ──────────────────────────────────────────────
// Menus
// ──────────────────────────────────────────────

app.use(
  "/api/menus",
  require("./routes/menuRoutes")
);


// ──────────────────────────────────────────────
// Items
// ──────────────────────────────────────────────

app.use(
  "/api/items",
  require("./routes/itemRoutes")
);


// ──────────────────────────────────────────────
// Menu templates
// ──────────────────────────────────────────────

app.use(
  "/api/menu-templates",
  require("./routes/menuTemplateRoutes")
);


// ──────────────────────────────────────────────
// Massive operations
// ──────────────────────────────────────────────

app.use(
  "/api/massive",
  require("./routes/massiveRoutes")
);


// ──────────────────────────────────────────────
// Gestión de pedidos (Postgres / Neon)
// ──────────────────────────────────────────────
//
// Módulo aparte en src/orders/: su propia base SQL,
// sin tocar los modelos de MongoDB (solo los lee).
// Sin DATABASE_URL estas rutas responden 503 y el
// resto de la API funciona igual.
//

app.use(
  "/api/orders",
  require("./orders/routes")
);


// ──────────────────────────────────────────────
// Reservas (Postgres / Neon + WebSocket)
// ──────────────────────────────────────────────
//
// Módulo aparte en src/reservations/, mismo criterio que
// pedidos: SQL para las reservas, Mongo solo de lectura.
// El WebSocket (/api/reservations/ws) se engancha al
// servidor HTTP al arrancar (ver start()).
//

app.use(
  "/api/reservations",
  require("./reservations/routes")
);


// ──────────────────────────────────────────────
// Sitemap
// ──────────────────────────────────────────────

app.get("/sitemap.xml", getSitemap);


// ──────────────────────────────────────────────
// Ping / monitoring
// ──────────────────────────────────────────────
//
// Endpoint simple para health checks.
//
// No hacemos console.log acá porque servicios como
// Koyeb o monitores externos pueden consultar este
// endpoint frecuentemente y llenar la terminal.
//

app.get("/ping", (req, res) => {
  res.json({
    status: "ok",
  });
});


// ──────────────────────────────────────────────
// Ruta pública multi-tenant
// ──────────────────────────────────────────────
//
// Ejemplo:
// /cafe-roma/menu
//
// En producción el frontend puede manejar esta ruta
// mediante React Router.
//
// Por ahora redirigimos al endpoint público de la API.
//

app.get("/:businessName/menu", (req, res) => {
  res.redirect(
    `/api/menus/public/${req.params.businessName}`
  );
});


// ──────────────────────────────────────────────
// Mercado Pago
// ──────────────────────────────────────────────
//
// Esta ruta queda fuera de mongoSanitize() porque
// los webhooks pueden utilizar parámetros como:
//
// data.id
//
// El contenido recibido debe validarse específicamente
// dentro de paymentRoutes.
//

const paymentRoutes = require("./routes/paymentRoutes");

app.use(
  "/api/payments",
  paymentRoutes
);


// ──────────────────────────────────────────────
// Health check principal
// ──────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    status: "API corriendo ✅",
  });
});


// ──────────────────────────────────────────────
// 404
// ──────────────────────────────────────────────
//
// Si ninguna ruta anterior coincide, devolvemos
// una respuesta controlada.
//

app.use((req, res) => {
  res.status(404).json({
    message: "Ruta no encontrada",
  });
});


// ──────────────────────────────────────────────
// Error handler global
// ──────────────────────────────────────────────
//
// Debe estar SIEMPRE después de todas las rutas.
//
// Esto permite capturar errores que escapen de los
// controllers/middlewares y devolver una respuesta
// controlada sin exponer stack traces ni rutas
// internas del servidor.
//

app.use((err, req, res, next) => {
  handleError(res, err);
});


// ──────────────────────────────────────────────
// Startup
// ──────────────────────────────────────────────
//
// En Koyeb el proceso escucha en PORT dentro del
// contenedor, pero desde afuera se entra por el
// dominio público. Koyeb lo inyecta en runtime como
// KOYEB_PUBLIC_DOMAIN; en local no existe y
// mostramos localhost.
//

const getServerUrl = () => {
  const publicDomain = process.env.KOYEB_PUBLIC_DOMAIN;

  if (publicDomain) {
    return `https://${publicDomain}`;
  }

  return `http://localhost:${PORT}`;
};

const printStartup = ({ postgresReady }) => {
  const environment =
    process.env.NODE_ENV || "development";

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🍽️  MENU DIGITAL API
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🚀 Server       ${getServerUrl()}
  🌐 Environment  ${environment}
  🟢 MongoDB      connected
  🐘 Postgres     ${postgresReady ? "connected" : "disabled"}
  📦 Plans        initialized
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ API ready
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
};


// ──────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────

const start = async () => {
  try {
    // Conectar MongoDB
    await connectDB();

    // Conectar Postgres (Neon) — opcional, en prueba.
    // Si falta DATABASE_URL o la conexión falla, la API
    // sigue funcionando solo con MongoDB.
    const postgresReady = await connectPostgres();

    // Inicializar catálogo de planes
    await initializePlans();

    // SMTP es opcional para levantar la API.
    // Si falta, mostramos un warning pero no detenemos
    // el servidor.
    if (
      !process.env.SMTP_USER ||
      !process.env.SMTP_PASS
    ) {
      console.warn(
        "⚠️  SMTP no configurado: emails de confirmación deshabilitados."
      );
    }

    // Iniciar HTTP server
    const server = app.listen(PORT, () => {
      printStartup({ postgresReady });
    });

    // Tiempo real (no interfiere con el resto de la API): cada módulo atiende su
    // propio path del mismo servidor y se corta cualquier otro upgrade.
    const reservationsRealtime = require("./reservations/realtime");
    const ordersRealtime = require("./orders/delivery/realtime");
    reservationsRealtime.attach(server);
    ordersRealtime.attach(server);
    reservationsRealtime.closeUnknownUpgrades(server, [reservationsRealtime.WS_PATH, ordersRealtime.WS_PATH]);
  } catch (error) {
    console.error(
      "❌ No se pudo iniciar la API con un catálogo válido:",
      error
    );

    process.exit(1);
  }
};


// ──────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────

start();