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

  // Visitas del día. Desde el protocolo de sesiones (utils/menuAnalytics.js)
  // una recarga o el dueño mirando su carta ya no suman; los días
  // anteriores cuentan cada carga.
  count: {
    type: Number,
    default: 0,
  },

  // Visitas por hora de Buenos Aires: { "0": n, …, "23": n }. Objeto y no
  // array porque el upsert hace $inc sobre "hours.<h>", y en un documento
  // nuevo Mongo crea esa ruta como clave de objeto.
  hours: {
    type: mongoose.Schema.Types.Mixed,
  },

  // Lo siguiente solo lo suma una carta con el protocolo nuevo, sin
  // defaults a propósito: un día sin estos campos es un día sin medición,
  // no un día con cero.
  // Visitas contadas con el protocolo nuevo (base de las proporciones).
  tracked: Number,
  // Dispositivos distintos del día y, de esos, los que ya habían entrado otro día.
  visitors: Number,
  returning: Number,
  // Visitas que llegaron por el QR descargado del panel.
  qr: Number,
  // Embudo, una vez por sesión: abrió un producto, armó un pedido.
  engaged: Number,
  carts: Number,
  // Pedidos enviados a WhatsApp (se abrió el chat con el pedido armado).
  orders: Number,
});

PageViewSchema.index({ userID: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("PageView", PageViewSchema);
