const mongoose = require("mongoose");

/**
 * Igual que PageView pero a nivel de producto: cuántas veces se tocó cada
 * item del menú, agregado por día. Guardamos userID junto a itemID (aunque
 * se podría derivar vía Item → Menu → User) para que la agregación de "top
 * platos" de un local no necesite un join extra por cada consulta.
 */
const ItemViewSchema = new mongoose.Schema({
  userID: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  itemID: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Item",
    required: true,
  },

  // Formato "YYYY-MM-DD" en horario de Buenos Aires, igual que PageView.
  date: {
    type: String,
    required: true,
  },

  count: {
    type: Number,
    default: 0,
  },
});

ItemViewSchema.index({ userID: 1, itemID: 1, date: 1 }, { unique: true });
// Para la agregación de "top platos" (todos los items de un user en un
// rango de fechas) sin tener que escanear por itemID primero.
ItemViewSchema.index({ userID: 1, date: 1 });

module.exports = mongoose.model("ItemView", ItemViewSchema);
