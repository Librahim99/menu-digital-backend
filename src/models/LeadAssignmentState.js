const mongoose = require("mongoose");

// Un único contador compartido por todas las instancias del backend.
// El $inc atómico evita asignar el mismo turno a dos registros simultáneos.
const schema = new mongoose.Schema({
  _id: { type: String },
  sequence: { type: Number, default: 0 },
});

module.exports = mongoose.model("LeadAssignmentState", schema);
