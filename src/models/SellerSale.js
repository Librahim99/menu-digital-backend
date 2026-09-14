const mongoose = require("mongoose");

// Snapshot inmutable de una venta atribuida a un vendedor, tomado en el
// momento en que el pago se aplica. sellerID es el vendedor que comisiona;
// influencerID conserva el origen del lead. Ambos vienen del checkout y no
// migran cuando se reasigna al cliente. La comisión del influencer queda
// congelada; la tabla de comisión normal sigue resuelta desde su panel.
const sellerSaleSchema = new mongoose.Schema(
  {
    // Clave natural del pago en MercadoPago (igual que PaymentTransaction).
    // unique + upsert por este campo evitan duplicar la venta si el webhook
    // reintenta la entrega.
    paymentID: { type: String, required: true, unique: true, trim: true },
    userID: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sellerID: { type: mongoose.Schema.Types.ObjectId, ref: "Seller", default: null },
    influencerID: { type: mongoose.Schema.Types.ObjectId, ref: "Seller", default: null },
    influencerRate: { type: Number, enum: [0, 0.15], default: 0 },
    influencerCommissionAmount: { type: Number, min: 0, default: 0 },
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
sellerSaleSchema.index({ influencerID: 1, subscriptionDate: -1 });

module.exports = mongoose.model("SellerSale", sellerSaleSchema);
