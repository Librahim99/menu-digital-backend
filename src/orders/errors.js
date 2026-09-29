const { handleError } = require("../utils/handleError");

// Error "esperado" del módulo de pedidos: su mensaje está pensado para el
// usuario y se devuelve tal cual con su status. Cualquier otro error pasa por
// handleError (mensaje genérico, nunca el detalle interno).
class OrdersError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "OrdersError";
    this.status = status;
    this.code = code;
  }
}

const sendError = (res, error) => {
  if (error instanceof OrdersError) {
    return res.status(error.status).json({ message: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  return handleError(res, error);
};

// Envuelve un controller async: los errores terminan siempre en sendError.
const route = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    sendError(res, error);
  }
};

module.exports = { OrdersError, sendError, route };
