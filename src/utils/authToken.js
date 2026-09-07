const jwt = require("jsonwebtoken");

// El role solo se agrega al payload cuando se lo pasan explícitamente, para
// no cambiar la forma de los tokens de User ya emitidos. protectSellerOrAdmin
// (middleware/auth.js) lo usa para distinguir un token de Seller sin tocar
// protect, que sigue resolviendo todo lo demás únicamente contra User.
const generateAuthToken = (id, role) =>
  jwt.sign(role ? { id, role } : { id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

module.exports = { generateAuthToken };
