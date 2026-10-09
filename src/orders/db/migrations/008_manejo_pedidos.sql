-- ──────────────────────────────────────────────────────────────────────────
-- Manejo de pedidos que no siguen su curso natural (tarjeta "Manejo de
-- pedidos"). Aditiva: no cambia ni borra nada existente.
--
--   · Estado por producto: una línea se puede quitar del pedido (falta de
--     stock, error de carga, lo pidió el cliente) sin anular el pedido entero.
--     No se borra: queda 'cancelled' con su motivo, y el total del pedido se
--     recalcula con las líneas activas.
--   · Entrega en partes: cada línea guarda cuándo se entregó (la bebida sale
--     antes que la comida, pero es un solo pedido).
--   · Auditoría de lo que se hizo con cada línea (quién, cuándo, cuánto).
--
-- Quitar solo una parte de la cantidad parte la línea en dos: la original
-- queda con lo que sigue en pie y se agrega otra 'cancelled' con lo quitado.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
DO $$ BEGIN
  ALTER TABLE order_items ADD CONSTRAINT order_items_status_check
    CHECK (status IN ('active', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

CREATE TABLE IF NOT EXISTS order_item_events (
  id             bigserial PRIMARY KEY,
  owner_id       text NOT NULL,
  order_id       bigint NOT NULL REFERENCES orders(id),
  order_item_id  bigint NOT NULL REFERENCES order_items(id),
  -- removed · restored · delivered · undelivered
  event_type     text NOT NULL CHECK (event_type IN ('removed', 'restored', 'delivered', 'undelivered')),
  quantity       integer NOT NULL,
  amount         numeric(12, 2) NOT NULL DEFAULT 0,   -- importe de la línea afectada
  reason         text,
  actor_type     text NOT NULL,
  actor_id       text,
  actor_name     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_item_events_order_idx ON order_item_events (order_id, created_at);
CREATE INDEX IF NOT EXISTS order_item_events_owner_idx ON order_item_events (owner_id, created_at DESC);

-- Nada se borra: misma política que el resto del módulo.
DROP TRIGGER IF EXISTS order_item_events_no_delete ON order_item_events;
CREATE TRIGGER order_item_events_no_delete BEFORE DELETE ON order_item_events
  FOR EACH ROW EXECUTE FUNCTION orders_prevent_delete();
DROP TRIGGER IF EXISTS order_item_events_no_truncate ON order_item_events;
CREATE TRIGGER order_item_events_no_truncate BEFORE TRUNCATE ON order_item_events
  FOR EACH STATEMENT EXECUTE FUNCTION orders_prevent_delete();
