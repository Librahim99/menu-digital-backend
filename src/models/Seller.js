const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const SellerSchema = new mongoose.Schema(
    {
        name: {
      type: String,
      required: [true, "El nombre es obligatorio"],
      unique: true,
      trim: true,
    }, code: {
      type: String,
      required: [true, "El código es obligatorio"],
      unique: true,
      trim: true,
    },
    dni: {
      type: String,
      required: [true, "El DNI es obligatorio"],
      unique: true,
      trim: true,
    }
    },{
    timestamps: true, // Agrega createdAt y updatedAt automáticamente
  }
)


module.exports = mongoose.model("Seller", SellerSchema);