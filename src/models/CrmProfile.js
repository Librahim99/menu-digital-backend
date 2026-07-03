const mongoose = require("mongoose");

// ──────────────────────────────────────────────
// Datos de CRM de un cliente (un local suscripto), para uso INTERNO del panel
// del CEO. Vive en su propia colección — NO se mete en el modelo User — a
// propósito: así estos datos internos (etapa, notas del equipo, seguimiento)
// nunca pueden filtrarse por los endpoints públicos de usuario (fetchUser por
// slug, la carta pública, etc.), que devuelven el documento User. Acá solo se
// llega por rutas /api/admin/crm gateadas con protect + isAdmin.
// ──────────────────────────────────────────────

// Etapas del pipeline de un cliente, de "recién entró" a "se dio de baja".
const STAGES = ["lead", "onboarding", "activo", "en_riesgo", "baja"];

// Cada nota es una entrada del historial de contacto/seguimiento. author guarda
// qué admin la escribió (por si mañana hay más de un CEO en el equipo).
// kind distingue las notas manuales ("note") de los eventos que loguea el
// propio sistema solo ("event": cambio de plan, activar/desactivar cuenta,
// cambio de template) — ambos viven en el mismo array así el timeline queda
// ordenado cronológicamente sin tener que mezclar dos colecciones distintas.
const NoteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    kind: { type: String, enum: ["note", "event"], default: "note" },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const CrmProfileSchema = new mongoose.Schema(
  {
    // Un perfil de CRM por cliente. unique evita duplicados si dos requests
    // intentan crearlo al mismo tiempo.
    userID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    stage: {
      type: String,
      enum: STAGES,
      default: "lead",
    },

    // Etiquetas libres para segmentar (ej: "cafetería", "alto volumen", "referido").
    tags: {
      type: [String],
      default: [],
    },

    // Fecha del próximo contacto/seguimiento agendado (null = sin agendar).
    // El front la resalta si ya venció.
    nextFollowUp: {
      type: Date,
      default: null,
    },

    // Historial de notas (lo más nuevo primero se ordena en el controller).
    notes: {
      type: [NoteSchema],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CrmProfile", CrmProfileSchema);
module.exports.STAGES = STAGES;
