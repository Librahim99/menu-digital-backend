-- ──────────────────────────────────────────────────────────────────────────
-- Gestión de pedidos — correcciones (tarjeta "Correcciones Gestion de
-- pedidos"). Todo aditivo: no se borra ni se renombra nada de la 001.
--
--   · Tipo de servicio del pedido (mesa / barra / take away / delivery) y
--     los datos de envío o de quien retira.
--   · Sesiones de mesa: de la primera comanda al cierre de la mesa.
--   · Caja separada del turno: cajas (varias por local), sesiones de caja
--     con cajero y el snapshot del cierre.
--   · Medios de pago y cobros: tablas listas, sin lógica todavía.
--   · Registro de cambios de estado (quién, cuándo, motivo).
--   · Más datos de la sesión del operador (dispositivo, cierre).
--   · Opciones extensibles del local (order_settings.options).
--   · Nada se borra: triggers que rechazan DELETE / TRUNCATE.
--
-- En la interfaz "mozo" pasa a llamarse "operador"; en la base se mantienen
-- los nombres waiter/waiters para no romper lo existente.
-- ──────────────────────────────────────────────────────────────────────────

-- ── Configuración extensible ─────────────────────────────────────────────
-- Opciones nuevas sin migración: claves conocidas con su valor por defecto
-- en settingsService (OPTION_DEFAULTS). Lo que no está acá toma el default.
ALTER TABLE order_settings ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── Cajas ────────────────────────────────────────────────────────────────
-- Un local puede tener varias (barra, salón, delivery…). Baja lógica.
CREATE TABLE IF NOT EXISTS cash_registers (
  id          bigserial PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES order_settings(owner_id),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS cash_registers_owner_idx ON cash_registers (owner_id) WHERE deleted_at IS NULL;

-- Sesión de caja: desde la apertura (con su cajero y fondo inicial) hasta el
-- cierre, independiente del turno. Al cerrar se congela el resultado del
-- momento; lo que pase después (ej. una devolución) va a la caja siguiente.
CREATE TABLE IF NOT EXISTS cash_sessions (
  id                  bigserial PRIMARY KEY,
  owner_id            text NOT NULL REFERENCES order_settings(owner_id),
  register_id         bigint NOT NULL REFERENCES cash_registers(id),
  register_name       text NOT NULL,              -- snapshot (la caja puede renombrarse)
  shift_id            bigint REFERENCES shifts(id), -- turno abierto al abrir la caja (informativo)
  cashier_name        text,                        -- snapshot del cajero
  opening_amount      numeric(12, 2) NOT NULL DEFAULT 0 CHECK (opening_amount >= 0),
  opened_at           timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  -- Snapshot del cierre
  orders_count        integer,                     -- todos los pedidos de la caja
  sales_count         integer,                     -- pedidos no anulados
  sales_amount        numeric(12, 2),              -- vendido bruto (no anulado)
  cancelled_count     integer,                     -- anulaciones
  cancelled_amount    numeric(12, 2),
  returned_count      integer,                     -- devoluciones registradas en esta caja
  returned_amount     numeric(12, 2),
  discounts_amount    numeric(12, 2),
  net_amount          numeric(12, 2),              -- vendido - devoluciones
  expected_cash       numeric(12, 2),
  cash_counted        numeric(12, 2),
  difference          numeric(12, 2),              -- contado - esperado
  payments_breakdown  jsonb,                       -- [{ method, kind, count, amount }]
  closing_notes       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_one_open_per_register ON cash_sessions (register_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS cash_sessions_owner_opened_idx ON cash_sessions (owner_id, opened_at DESC);

-- Una "Caja principal" para cada local que ya usa el módulo.
INSERT INTO cash_registers (owner_id, name)
SELECT s.owner_id, 'Caja principal' FROM order_settings s
WHERE NOT EXISTS (SELECT 1 FROM cash_registers r WHERE r.owner_id = s.owner_id);

-- ── Sesiones de mesa ─────────────────────────────────────────────────────
-- Empieza con el primer pedido de la mesa y termina al cerrar la mesa (desde
-- el tomador del operador o desde el panel). Una sola abierta por mesa.
CREATE TABLE IF NOT EXISTS table_sessions (
  id              bigserial PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES order_settings(owner_id),
  table_number    integer NOT NULL CHECK (table_number > 0),
  shift_id        bigint REFERENCES shifts(id),   -- turno en el que se abrió
  waiter_id       bigint REFERENCES waiters(id),  -- operador a cargo
  waiter_name     text,                           -- snapshot
  guests          integer CHECK (guests BETWEEN 1 AND 200),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  -- 'waiter' (tomador del operador) · 'panel' (panel de pedidos)
  closed_by_type  text CHECK (closed_by_type IN ('waiter', 'panel')),
  closed_by_name  text,
  -- Snapshot al cerrar
  orders_count    integer,
  total_amount    numeric(12, 2),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS table_sessions_one_open_per_table ON table_sessions (owner_id, table_number) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS table_sessions_owner_opened_idx ON table_sessions (owner_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS table_sessions_waiter_idx ON table_sessions (waiter_id, opened_at DESC);

-- ── Sesiones de los dispositivos de los operadores ───────────────────────
ALTER TABLE waiter_sessions ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE waiter_sessions ADD COLUMN IF NOT EXISTS device_label text;
-- 'logout' · 'revoked' (desde el panel) · 'paused' · 'deleted'
ALTER TABLE waiter_sessions ADD COLUMN IF NOT EXISTS ended_reason text;
ALTER TABLE waiter_sessions ADD COLUMN IF NOT EXISTS waiter_name text; -- snapshot al vincular

-- ── Pedidos ──────────────────────────────────────────────────────────────
-- table: en una mesa · counter: barra / mostrador · takeaway · delivery
ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_type text NOT NULL DEFAULT 'table';
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_service_type_check
    CHECK (service_type IN ('table', 'counter', 'takeaway', 'delivery'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
UPDATE orders SET service_type = 'counter' WHERE table_number IS NULL AND service_type = 'table';

-- Datos de envío (delivery) o de quien retira (take away).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_notes text;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_session_id bigint REFERENCES table_sessions(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_session_id bigint REFERENCES cash_sessions(id);
-- Caja abierta en el momento de la devolución (puede ser otra que la de la venta).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS returned_cash_session_id bigint REFERENCES cash_sessions(id);
-- Dispositivo del operador que cargó el pedido.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS waiter_session_id bigint REFERENCES waiter_sessions(id);
-- Motivo de la anulación o devolución.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_reason text;
-- Preparado para descuentos: total = subtotal - discount_amount.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal numeric(12, 2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount numeric(12, 2) NOT NULL DEFAULT 0;
UPDATE orders SET subtotal = total WHERE subtotal IS NULL;

CREATE INDEX IF NOT EXISTS orders_table_session_idx ON orders (table_session_id) WHERE table_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_cash_session_idx ON orders (cash_session_id) WHERE cash_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_returned_cash_session_idx ON orders (returned_cash_session_id) WHERE returned_cash_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_owner_waiter_idx ON orders (owner_id, waiter_id, created_at DESC) WHERE waiter_id IS NOT NULL;

-- Categoría del producto al momento del pedido (para reportes por categoría).
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS category_id text;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS category_name text;

-- ── Registro de cambios de estado ────────────────────────────────────────
-- Una fila por transición (incluida el alta). Las columnas *_at de orders
-- guardan la última vez; acá queda la historia completa para medir tiempos
-- (pedido → confirmado → listo → entregado) aunque haya idas y vueltas.
CREATE TABLE IF NOT EXISTS order_status_events (
  id           bigserial PRIMARY KEY,
  order_id     bigint NOT NULL REFERENCES orders(id),
  owner_id     text NOT NULL,
  from_status  text,
  to_status    text NOT NULL,
  -- customer · waiter · panel · system
  actor_type   text NOT NULL CHECK (actor_type IN ('customer', 'waiter', 'panel', 'system')),
  actor_id     text,
  actor_name   text,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_status_events_order_idx ON order_status_events (order_id, created_at);
CREATE INDEX IF NOT EXISTS order_status_events_owner_idx ON order_status_events (owner_id, created_at DESC);

-- Estado actual de los pedidos existentes como primer evento.
INSERT INTO order_status_events (order_id, owner_id, from_status, to_status, actor_type, created_at)
SELECT o.id, o.owner_id, NULL, o.status, 'system', o.updated_at FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM order_status_events e WHERE e.order_id = o.id);

-- ── Medios de pago y cobros (preparado, sin lógica todavía) ──────────────
CREATE TABLE IF NOT EXISTS payment_methods (
  id          bigserial PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES order_settings(owner_id),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  kind        text NOT NULL DEFAULT 'other'
              CHECK (kind IN ('cash', 'debit', 'credit', 'transfer', 'mercadopago', 'voucher', 'other')),
  active      boolean NOT NULL DEFAULT true,
  position    smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS payment_methods_owner_idx ON payment_methods (owner_id) WHERE deleted_at IS NULL;

-- Un cobro: de un pedido o de toda una sesión de mesa, en una caja. Se anula
-- (voided), nunca se borra. idempotency_key evita cobros duplicados.
CREATE TABLE IF NOT EXISTS payments (
  id                 bigserial PRIMARY KEY,
  owner_id           text NOT NULL REFERENCES order_settings(owner_id),
  cash_session_id    bigint REFERENCES cash_sessions(id),
  order_id           bigint REFERENCES orders(id),
  table_session_id   bigint REFERENCES table_sessions(id),
  payment_method_id  bigint REFERENCES payment_methods(id),
  method_name        text NOT NULL,   -- snapshot
  method_kind        text NOT NULL,   -- snapshot
  amount             numeric(12, 2) NOT NULL CHECK (amount > 0),
  tip_amount         numeric(12, 2) NOT NULL DEFAULT 0 CHECK (tip_amount >= 0),
  status             text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'voided')),
  reference          text,            -- nº de operación, últimos 4, etc.
  waiter_id          bigint REFERENCES waiters(id),
  waiter_name        text,            -- snapshot
  idempotency_key    uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  voided_at          timestamptz,
  void_reason        text,
  UNIQUE (owner_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS payments_cash_session_idx ON payments (cash_session_id);
CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_table_session_idx ON payments (table_session_id) WHERE table_session_id IS NOT NULL;

-- ── Nada se borra ────────────────────────────────────────────────────────
-- Todo es histórico: bajas lógicas (deleted_at, active, revoked_at, closed_at,
-- status). Un DELETE o TRUNCATE en estas tablas falla.
CREATE OR REPLACE FUNCTION orders_prevent_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'No se permiten borrados en %: usá una baja lógica.', TG_TABLE_NAME;
END
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'order_settings', 'order_tables', 'waiters', 'waiter_sessions', 'shifts', 'orders',
    'order_items', 'order_status_events', 'table_sessions', 'cash_registers', 'cash_sessions',
    'payment_methods', 'payments'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION orders_prevent_delete()', t || '_no_delete', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION orders_prevent_delete()', t || '_no_truncate', t);
  END LOOP;
END $$;
