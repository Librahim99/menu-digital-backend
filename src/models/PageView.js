const mongoose = require("mongoose");

/**
 * Agregado diario de visitas a la carta pública de un local (una fila por
 * usuario por día, con un contador que se incrementa en cada vista). No
 * guardamos un documento por visita individual — para el alcance de esta
 * feature (estadísticas básicas del panel) alcanza con el total por día,
 * y evita que la colección crezca sin límite.
 */
const PageViewSchema = new mongoose.Schema({
  userID: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  // Formato "YYYY-MM-DD", en vez de un Date, para poder hacer upsert
  // por día sin lidiar con husos horarios ni rangos de fecha en la query.
  date: {
    type: String,
    required: true,
  },

  count: {
    type: Number,
    default: 0,
  },
});

PageViewSchema.index({ userID: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("PageView", PageViewSchema);
