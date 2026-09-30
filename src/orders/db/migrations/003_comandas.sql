-- ──────────────────────────────────────────────────────────────────────────
-- Gestión de pedidos — comandas por sector (tarjeta "Comandas"). Aditivo:
-- el código anterior sigue andando contra este esquema.
--
--   · Sectores del local (cocina, barra, postres…) con su configuración de
--     impresión (preparada: todavía no se probó con una comandera real).
--   · A qué sector va cada sección, categoría o producto del menú. Los ids
--     son de Mongo; la resolución es en cascada: producto > categoría >
--     sección > sector por defecto (ver services/sectorService.js).
--   · Comandas: la parte de un pedido confirmado que le toca a un sector.
--   · Dispositivos de cada sector (PC, tablet), vinculados con un código
--     corto que se tipea: sin QR y sin la sesión del dueño.
--
-- Sin sectores creados no se generan comandas: el local trabaja con el panel
-- de pedidos como hasta ahora.
-- ──────────────────────────────────────────────────────────────────────────

-- ── Sectores ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_sectors (
  id                  bigserial PRIMARY KEY,
  owner_id            text NOT NULL REFERENCES order_settings(owner_id),
  name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  -- Recibe lo que no tiene sector asignado (ni heredado). Uno por local.
  is_default          boolean NOT NULL DEFAULT false,
  position            smallint NOT NULL DEFAULT 0,
  -- Impresión de comandas:
  --   none: se trabaja solo en pantalla · browser: impresora del sistema
  --   (diálogo de impresión del navegador) · escpos: comandera térmica
  --   directa desde el navegador (experimental).
  print_mode          text NOT NULL DEFAULT 'none' CHECK (print_mode IN ('none', 'browser', 'escpos')),
  paper_width         smallint NOT NULL DEFAULT 80 CHECK (paper_width IN (58, 80)),
  print_copies        smallint NOT NULL DEFAULT 1 CHECK (print_copies BETWEEN 1 AND 3),
  -- Código para vincular un dispositivo: de un solo uso, vence en minutos.
  -- Solo se guarda el hash.
  pairing_code_hash   text UNIQUE,
  pairing_expires_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE INDEX IF NOT EXISTS order_sectors_owner_idx ON order_sectors (owner_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS order_sectors_one_default ON order_sectors (owner_id)
  WHERE is_default AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS order_sectors_unique_name ON order_sectors (owner_id, lower(name))
  WHERE deleted_at IS NULL;

-- ── Asignaciones del menú ────────────────────────────────────────────────
-- Una fila por elemento con sector propio; sin fila, hereda. Es
-- configuración (no historia): volver a "heredar" borra la fila, por eso
-- esta tabla no lleva el trigger que prohíbe borrados.
CREATE TABLE IF NOT EXISTS order_sector_assignments (
  owner_id     text NOT NULL REFERENCES order_settings(owner_id),
  target_type  text NOT NULL CHECK (target_type IN ('section', 'category', 'item')),
  target_id    text NOT NULL,
  sector_id    bigint NOT NULL REFERENCES order_sectors(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS order_sector_assignments_sector_idx ON order_sector_assignments (sector_id);

-- ── Comandas ─────────────────────────────────────────────────────────────
-- Se crean al confirmar el pedido, una por sector que tenga algo que
-- preparar. Anular el pedido (o volverlo a "sin confirmar") las anula; al
-- reconfirmarlo vuelven a "nueva" y se reimprimen.
CREATE TABLE IF NOT EXISTS order_tickets (
  id            bigserial PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES order_settings(owner_id),
  order_id      bigint NOT NULL REFERENCES orders(id),
  sector_id     bigint NOT NULL REFERENCES order_sectors(id),
  sector_name   text NOT NULL,                  -- snapshot (el sector puede renombrarse)
  -- new: recién llegada · preparing: el sector la está preparando
  -- · done: preparada · cancelled: el pedido se anuló
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'preparing', 'done', 'cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  done_at       timestamptz,
  cancelled_at  timestamptz,
  -- Impresión: la marca el dispositivo que la imprimió.
  printed_at    timestamptz,
  print_count   integer NOT NULL DEFAULT 0,
  UNIQUE (order_id, sector_id)
);
CREATE INDEX IF NOT EXISTS order_tickets_sector_status_idx ON order_tickets (sector_id, status, created_at);
CREATE INDEX IF NOT EXISTS order_tickets_order_idx ON order_tickets (order_id);

-- Sección del producto al momento del pedido (para resolver el sector sin
-- volver a Mongo al confirmar) y la comanda a la que fue la línea.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS section_id text;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS ticket_id bigint REFERENCES order_tickets(id);
CREATE INDEX IF NOT EXISTS order_items_ticket_idx ON order_items (ticket_id) WHERE ticket_id IS NOT NULL;

-- ── Dispositivos de los sectores ─────────────────────────────────────────
-- Igual que waiter_sessions: el token queda en el localStorage del equipo.
CREATE TABLE IF NOT EXISTS sector_sessions (
  id            bigserial PRIMARY KEY,
  sector_id     bigint NOT NULL REFERENCES order_sectors(id),
  owner_id      text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  user_agent    text,
  device_label  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  -- 'logout' · 'revoked' (desde el panel) · 'deleted' (se borró el sector)
  ended_reason  text
);
CREATE INDEX IF NOT EXISTS sector_sessions_sector_idx ON sector_sessions (sector_id) WHERE revoked_at IS NULL;

-- ── Nada se borra (salvo las asignaciones) ───────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_sectors', 'order_tickets', 'sector_sessions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION orders_prevent_delete()', t || '_no_delete', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION orders_prevent_delete()', t || '_no_truncate', t);
  END LOOP;
END $$;
