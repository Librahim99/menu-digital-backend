// Loguea el error real server-side y responde al cliente con un mensaje
// genérico. Nunca reenviamos error.message al cliente: puede filtrar
// nombres de modelos/campos de Mongoose, rutas del filesystem, mensajes
// internos de bcrypt, etc. — información que solo sirve para debug interno,
// nunca para el usuario final (y sí le sirve a un atacante).
const handleError = (res, error, status = 500) => {
  console.error(error);
  if (error?.code === "PLAN_CATALOG_UNAVAILABLE") {
    return res.status(503).json({ code: error.code, message: "No se pudo consultar el plan. Intentá de nuevo." });
  }
  if (error?.code === "INVALID_EXCEL_FILE") {
    return res.status(400).json({ code: error.code, message: error.message });
  }
  res.status(status).json({ message: "Ocurrió un error interno. Intentá de nuevo." });
};

module.exports = { handleError };
