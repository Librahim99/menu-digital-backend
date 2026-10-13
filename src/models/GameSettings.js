const mongoose = require("mongoose");

/**
 * Configuración de los juegos para comensales de un local (uno por User).
 *
 * `config` guarda qué juegos están habilitados y las opciones de cada uno.
 * Su forma la definen y validan los módulos de src/games (registry.js): es
 * Mixed para que sumar un juego no requiera tocar este schema. Nunca se
 * escribe sin pasar por games/settingsService.js.
 */
const GameSettingsSchema = new mongoose.Schema(
  {
    userID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    config: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model("GameSettings", GameSettingsSchema);
