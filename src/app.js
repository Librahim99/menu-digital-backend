const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const connectDB = require("./config/db");

// ──────────────────────────────────────────────
// Conexión a la base de datos
// ──────────────────────────────────────────────
connectDB();

const app = express();

// ──────────────────────────────────────────────
// Middlewares globales
// ──────────────────────────────────────────────
app.use(cors()); // Permite requests desde el frontend (configurar origins en producción)
app.use(express.json()); // Parsea el body de las requests como JSON
app.use(express.urlencoded({ extended: true }));


// ──────────────────────────────────────────────
// Rutas de la API
// ──────────────────────────────────────────────
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
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok' });
  console.log(`running... ${new Date().toLocaleString()}`)
});

app.get("/:businessName/menu", (req, res) => {
  // Por ahora redirige al endpoint público de la API.
  // En producción esto lo maneja el frontend (React).
  res.redirect(`/api/menus/public/${req.params.businessName}`);
});

//Mercado Pago
const paymentRoutes = require("./routes/payment.routes");
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
// Inicio del servidor
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});