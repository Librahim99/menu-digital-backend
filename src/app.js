const express = require("express");
const cors = require("cors");
const path = require("path");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");
require("dotenv").config();

const connectDB = require("./config/db");
const { validateEnvironment } = require("./config/environment");
const { handleError } = require("./utils/handleError");
const { apiLimiter } = require("./middleware/rateLimiters");

// ──────────────────────────────────────────────
// Validación de configuración y conexión a la base de datos
// ──────────────────────────────────────────────
// Fallar antes de abrir el puerto evita aceptar registros o pagos con una
// configuración parcial, credenciales de prueba en producción o sin firma.
validateEnvironment();
connectDB();

const app = express();

// Detrás de un proxy/balanceador (Koyeb) el request le llega a Express con
// la IP del proxy, no la del cliente real — sin esto, express-rate-limit
// contaría a TODOS los usuarios como si fueran una sola IP.
app.set("trust proxy", 1);

// ──────────────────────────────────────────────
// Middlewares globales
// ──────────────────────────────────────────────
// Headers de seguridad estándar (X-Content-Type-Options, X-Frame-Options,
// HSTS, saca X-Powered-By, etc.). API pura sin vistas HTML propias, así que
// el CSP por default de helmet no rompe nada — no servimos páginas.
// crossOriginResourcePolicy en "same-origin" (el default) es para apps que
// SIRVEN algo (imágenes, scripts) y no quieren que otros orígenes lo
// carguen — achá es al revés: el frontend (otro origen) tiene que poder
// consumir esta API sí o sí, eso ya lo gobierna el allowlist de CORS de
// abajo, así que lo dejamos en "cross-origin" para no pisarlo.
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));
app.use(cors({
  origin: [
    'https://menu-digital-app-v1-gamma.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());  // preflight
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Saca claves tipo operador de Mongo ($ne, $regex, etc.) de body/query/params
// — sin esto, mandar {"username": {"$ne": null}} en vez de un string hace
// que Mongoose lo interprete como operador de la query en vez de un valor
// literal (inyección NoSQL).
// NO se aplica a /api/payments: el webhook de MercadoPago manda el
// paymentId en un query param literal "data.id" (con punto) — el sanitizer
// también saca claves con puntos (mismo criterio que las de $) y nos
// rompía el webhook entero.
app.use(["/api/users", "/api/menus", "/api/items", "/api/admin", "/api/massive"], mongoSanitize());
// Red de contención general contra abuso/scraping — los límites más
// estrictos de login/registro (authLimiter) se suman a este en sus rutas.
app.use("/api", apiLimiter);


// ──────────────────────────────────────────────
// Rutas de la API
// ──────────────────────────────────────────────
// El CRM va ANTES de /api/admin para que su prefijo (más específico) matchee
// primero y no lo intercepte el GET /:userID de adminRoutes.
app.use("/api/admin/crm", require("./routes/crmRoutes"));
app.use("/api/admin", require("./routes/adminRoutes"))
app.use("/api/users", require("./routes/userRoutes"));
app.use("/api/menus", require("./routes/menuRoutes"));
app.use("/api/items", require("./routes/itemRoutes"));
app.use("/api/massive", require("./routes/massiveRoutes"));

// ──────────────────────────────────────────────
// Ruta pública multi-tenant: /:businessName/menu
// Ej: menudigital.com.ar/cafe-roma/menu
// Esta ruta puede resolverse en el front con React Router,
// o acá si queremos un SSR / redirect.
// ──────────────────────────────────────────────


app.get('/ping', (req, res) => {
  console.log(`running... ${new Date().toLocaleString()}`)
  res.json({ status: 'ok' }); 
});

app.get("/:businessName/menu", (req, res) => {
  // Por ahora redirige al endpoint público de la API.
  // En producción esto lo maneja el frontend (React).
  res.redirect(`/api/menus/public/${req.params.businessName}`);
});

//Mercado Pago
const paymentRoutes = require("./routes/paymentRoutes");
app.use("/api/payments", paymentRoutes);

// ──────────────────────────────────────────────
// Health check
// ──────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "API corriendo ✅" }));

// ──────────────────────────────────────────────
// Manejo de rutas no encontradas
// ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: "Ruta no encontrada" });
});

// ──────────────────────────────────────────────
// Manejo de errores no capturados — SIEMPRE al final, después de todas las
// rutas. Antes de esto no existía, así que un error que se escapara de un
// try/catch (ej. JSON malformado, que body-parser rechaza antes de que
// cualquier controller lo vea) caía en el handler default de Express, que
// devuelve el stack trace completo — incluida la ruta real del filesystem
// del servidor — a quien sea que hizo el request.
// ──────────────────────────────────────────────
app.use((err, req, res, next) => {
  handleError(res, err);
});

// ──────────────────────────────────────────────
// Inicio del servidor
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
