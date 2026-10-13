-- ──────────────────────────────────────────────────────────────────────────
-- Cuenta inteligente y pedidos grupales (tarjeta "Dividir cuenta / multi
-- pedido"). Aditiva: no cambia ni borra nada existente.
--
--   · Cuenta de la mesa: comensales (bill_guests), cómo se reparte cada
--     producto entre ellos (bill_item_shares, por "partes": un producto entero
--     para uno o fraccionado entre varios) y el modo de división de la mesa
--     (por productos, partes iguales o importes personalizados).
--   · Pagos parciales: se registran a mano en `payments` (tabla de la 002, que
--     no tenía lógica). Se suma quién pagó y quién lo registró. No hay cobro
--     online: ni Mercado Pago ni nada desde el celular del cliente.
--   · Historial de cambios de la cuenta (bill_events).
--   · Pedidos grupales: una sesión por mesa (group_sessions) a la que los
--     comensales se suman con un QR / enlace / código (group_members) y cargan
--     productos en un carrito común (group_cart_items). Al enviarlo sale UN
--     pedido por el flujo de siempre; cada línea guarda quién la pidió y si es
--     un consumo individual o compartido.
--
-- Los importes de la cuenta no se guardan: se calculan siempre a partir de los
-- pedidos de la mesa (services/billMath.js), así el total nunca se desfasa.
-- ──────────────────────────────────────────────────────────────────────────

-- ── Pedidos grupales ─────────────────────────────────────────────────────
-- Una sola sesión abierta por mesa. Se cierra con la mesa (o a mano).
CREATE TABLE IF NOT EXISTS group_sessions (
  id                bigserial PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES order_settings(owner_id),
  table_number      integer NOT NULL CHECK (table_number > 0),
  -- Sesión de mesa a la que fueron sus pedidos (se completa con el primero).
  table_session_id  bigint REFERENCES table_sessions(id),
  -- Código corto que se tipea para unirse (único entre las abiertas del local).
  code              text NOT NULL,
  -- Secreto del QR / enlace para unirse.
  join_token        text NOT NULL UNIQUE,
  created_by_type   text NOT NULL CHECK (created_by_type IN ('customer', 'waiter', 'panel')),
  created_by_name   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  -- 'table_closed' · 'staff' · 'expired'
  closed_reason     text
);
CREATE UNIQUE INDEX IF NOT EXISTS group_sessions_one_open_per_table ON group_sessions (owner_id, table_number) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS group_sessions_open_code ON group_sessions (owner_id, code) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS group_sessions_owner_idx ON group_sessions (owner_id, created_at DESC);

-- Integrantes: cada celular que se sumó. El token queda en su navegador; acá
-- solo el hash.
CREATE TABLE IF NOT EXISTS group_members (
  id                bigserial PRIMARY KEY,
  group_session_id  bigint NOT NULL REFERENCES group_sessions(id),
  owner_id          text NOT NULL,
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  token_hash        text NOT NULL UNIQUE,
  joined_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  left_at           timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS group_members_unique_name ON group_members (group_session_id, lower(name)) WHERE left_at IS NULL;

-- Carrito común: lo que cada integrante quiere pedir. Título y precio son
-- para mostrarlo; al enviar se vuelve a cotizar contra el menú.
CREATE TABLE IF NOT EXISTS group_cart_items (
  id                bigserial PRIMARY KEY,
  group_session_id  bigint NOT NULL REFERENCES group_sessions(id),
  owner_id          text NOT NULL,
  member_id         bigint NOT NULL REFERENCES group_members(id),
  item_id           text NOT NULL,
  title             text NOT NULL,
  option_name       text,
  unit_price        numeric(12, 2) NOT NULL CHECK (unit_price >= 0),
  quantity          integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  notes             text,
  -- true: es para compartir entre todos (ej. una pizza al medio).
  shared            boolean NOT NULL DEFAULT false,
  -- Id que genera el navegador al agregar: un reintento no lo carga dos veces.
  client_item_id    uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  removed_at        timestamptz,
  -- Pedido en el que salió (null: todavía en el carrito).
  order_id          bigint REFERENCES orders(id),
  UNIQUE (group_session_id, client_item_id)
);
CREATE INDEX IF NOT EXISTS group_cart_items_pending_idx ON group_cart_items (group_session_id)
  WHERE order_id IS NULL AND removed_at IS NULL;

-- Pedido que salió de un grupo, y quién pidió cada línea.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS group_session_id bigint REFERENCES group_sessions(id);
CREATE INDEX IF NOT EXISTS orders_group_session_idx ON orders (group_session_id) WHERE group_session_id IS NOT NULL;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS group_member_id bigint REFERENCES group_members(id);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS author_name text;   -- snapshot
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS shared boolean NOT NULL DEFAULT false;

-- ── Cuenta de la mesa ────────────────────────────────────────────────────
-- none: sin dividir · items: cada uno paga lo que se le asignó
-- · equal: partes iguales · custom: importe a mano por comensal
ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS split_mode text NOT NULL DEFAULT 'none';
DO $$ BEGIN
  ALTER TABLE table_sessions ADD CONSTRAINT table_sessions_split_mode_check
    CHECK (split_mode IN ('none', 'items', 'equal', 'custom'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Snapshot al cerrar la mesa: lo cobrado con pagos registrados.
ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS paid_amount numeric(12, 2);

CREATE TABLE IF NOT EXISTS bill_guests (
  id                bigserial PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES order_settings(owner_id),
  table_session_id  bigint NOT NULL REFERENCES table_sessions(id),
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  position          smallint NOT NULL DEFAULT 0,
  -- Solo en modo 'custom': lo que paga este comensal.
  custom_amount     numeric(12, 2) CHECK (custom_amount >= 0),
  -- Integrante del pedido grupal del que salió (null: lo cargó el personal).
  group_member_id   bigint REFERENCES group_members(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  removed_at        timestamptz
);
CREATE INDEX IF NOT EXISTS bill_guests_session_idx ON bill_guests (table_session_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bill_guests_one_per_member ON bill_guests (table_session_id, group_member_id)
  WHERE group_member_id IS NOT NULL AND removed_at IS NULL;

-- Reparto de una línea de pedido: weight son "partes". Una fila con weight 1
-- = todo el producto para ese comensal; tres filas con weight 1 = un tercio
-- cada uno; 2 y 1 = dos tercios y un tercio. Sin filas: sin asignar.
-- Es configuración (reasignar borra filas); la historia queda en bill_events.
CREATE TABLE IF NOT EXISTS bill_item_shares (
  order_item_id     bigint NOT NULL REFERENCES order_items(id),
  guest_id          bigint NOT NULL REFERENCES bill_guests(id),
  owner_id          text NOT NULL,
  table_session_id  bigint NOT NULL REFERENCES table_sessions(id),
  weight            integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 100),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_item_id, guest_id)
);
CREATE INDEX IF NOT EXISTS bill_item_shares_session_idx ON bill_item_shares (table_session_id);

-- Pagos manuales: a quién se le imputa, quién pagó y quién lo registró.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS guest_id bigint REFERENCES bill_guests(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payer_name text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS actor_type text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS actor_name text;

-- Historial de la cuenta: comensales, repartos, modo de división y pagos.
CREATE TABLE IF NOT EXISTS bill_events (
  id                bigserial PRIMARY KEY,
  owner_id          text NOT NULL,
  table_session_id  bigint NOT NULL REFERENCES table_sessions(id),
  -- guest_added · guest_renamed · guest_removed · split_changed · amounts_set
  -- · item_assigned · payment_recorded · payment_voided · group_order
  event_type        text NOT NULL,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type        text NOT NULL,
  actor_id          text,
  actor_name        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bill_events_session_idx ON bill_events (table_session_id, created_at DESC);

-- ── Nada se borra (salvo el reparto, que es configuración) ───────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['group_sessions', 'group_members', 'group_cart_items', 'bill_guests', 'bill_events'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION orders_prevent_delete()', t || '_no_delete', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION orders_prevent_delete()', t || '_no_truncate', t);
  END LOOP;
END $$;
