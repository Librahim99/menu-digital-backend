const jwt = require("jsonwebtoken");

const generateAuthToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

module.exports = { generateAuthToken };
