-- ──────────────────────────────────────────────────────────────────────────
-- Reservas (Postgres / Neon) — esquema inicial.
--
-- Los locales, planes y números de WhatsApp siguen en MongoDB. Acá viven las
-- reservas y la configuración del módulo por local:
--   owner_id = User._id del local (texto, igual que en Gestión de pedidos)
-- Fecha y hora son "de pared" en horario de Buenos Aires (sin zona horaria):
-- una reserva "22:00 del 12/10" es eso mismo en la base.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reservation_settings (
  owner_id           text PRIMARY KEY,
  -- Mientras sea false la landing no ofrece reservas online (queda WhatsApp).
  enabled            boolean NOT NULL DEFAULT false,
  -- ¿Se le pide un teléfono al cliente? off = no se pide.
  phone_mode         text NOT NULL DEFAULT 'optional'
                     CHECK (phone_mode IN ('off', 'optional', 'required')),
  max_party_size     integer NOT NULL DEFAULT 12
                     CHECK (max_party_size BETWEEN 1 AND 100),
  max_days_ahead     integer NOT NULL DEFAULT 60
                     CHECK (max_days_ahead BETWEEN 1 AND 365),
  -- Anticipación mínima para pedir una reserva desde la landing.
  min_notice_minutes integer NOT NULL DEFAULT 60
                     CHECK (min_notice_minutes BETWEEN 0 AND 10080),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
  id              bigserial PRIMARY KEY,
  owner_id        text NOT NULL,
  -- Código de reserva (8 caracteres, ver orders/utils/tokens.js): es lo que el
  -- cliente guarda en su navegador y puede tipear en otro dispositivo.
  code            text NOT NULL UNIQUE,
  customer_name   text NOT NULL,
  customer_phone  text,
  party_size      integer NOT NULL CHECK (party_size > 0),
  reserve_date    date NOT NULL,
  reserve_time    time NOT NULL,
  -- pending:   esperando que el local la vea
  -- confirmed: confirmada (con mesa)
  -- rejected:  el local no puede en ese horario (puede proponer otro)
  -- cancelled: cancelada por el cliente o por el local
  -- completed / no_show: cierre posterior a la fecha
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled', 'completed', 'no_show')),
  -- web: la pidió el cliente desde la landing. manual: la cargó el local.
  source          text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'manual')),
  table_label     text,
  -- Horario alternativo que propone el local al rechazar.
  alt_date        date,
  alt_time        time,
  -- Mensaje del local para el cliente (motivo del rechazo, aclaraciones).
  message         text,
  -- Aclaraciones del cliente ("cumpleaños", "silla de bebé").
  notes           text,
  internal_notes  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reservations_owner_date_idx
  ON reservations (owner_id, reserve_date, reserve_time);
CREATE INDEX IF NOT EXISTS reservations_owner_status_idx
  ON reservations (owner_id, status);
