const mongoose = require("mongoose");

/**
 * Conecta la aplicación a MongoDB usando la URI del .env
 * Se llama una sola vez al iniciar el servidor
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    console.log(`✅ MongoDB conectado: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ Error al conectar MongoDB: ${error.message}`);
    process.exit(1); // Detiene el proceso si no hay conexión
  }
};

module.exports = connectDB;
