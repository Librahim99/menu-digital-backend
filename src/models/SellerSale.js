const mongoose = require("mongoose");

// Snapshot inmutable de una venta atribuida a un vendedor, tomado en el
// momento en que el pago se aplica. sellerID es siempre el mismo sellerID que
// tiene el User en ese momento (el vendedor normal, o el vendedor influencer
// cuando el lead vino referido) — viene del checkout y no migra cuando se
// reasigna el seguimiento del cliente (assignedSeller) a otro vendedor. La
// comisión, tanto de vendedores normales como de influencers, nunca se guarda
// acá: se recalcula siempre a partir de `amount` desde su propio panel.
const sellerSaleSchema = new mongoose.Schema(
  {
    // Clave natural del pago en MercadoPago (igual que PaymentTransaction).
    // unique + upsert por este campo evitan duplicar la venta si el webhook
    // reintenta la entrega.
    paymentID: { type: String, required: true, unique: true, trim: true },
    userID: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sellerID: { type: mongoose.Schema.Types.ObjectId, ref: "Seller", default: null },
    plan: { type: String, enum: ["basic", "pro"], required: true },
    amount: { type: Number, required: true, min: 0 },
    months: { type: Number, enum: [1, 3, 6, 12], required: true },
    subscriptionDate: { type: Date, required: true },
    // Estado financiero actualizado: conserva intactos los importes brutos
    // para que un reembolso no reescriba el historial de la conversión.
    refundedAmount: { type: Number, min: 0, default: 0 },
    paymentStatus: { type: String, default: "approved" },
  },
  { timestamps: true }
);

sellerSaleSchema.index({ sellerID: 1, subscriptionDate: -1 });

module.exports = mongoose.model("SellerSale", sellerSaleSchema);
