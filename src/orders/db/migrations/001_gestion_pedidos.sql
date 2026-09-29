-- ──────────────────────────────────────────────────────────────────────────
-- Gestión de pedidos (Postgres / Neon) — esquema inicial.
--
-- Todo lo del menú, los locales y los planes sigue en MongoDB. Acá solo vive
-- la operación diaria de pedidos. Los ids de Mongo se guardan como texto:
--   owner_id = User._id del local (dueño del comercio)
--   item_id  = Item._id del producto
-- Del producto se congela título, variante y precio al momento del pedido
-- (pueden cambiar después en el menú y los reportes tienen que reflejar lo
-- que se vendió de verdad).
-- ──────────────────────────────────────────────────────────────────────────

-- Configuración del módulo por local. Se crea la primera vez que el dueño
-- entra a Gestión de pedidos.
CREATE TABLE IF NOT EXISTS order_settings (
  owner_id           text PRIMARY KEY,
  -- 'general': un único QR y el comensal indica su mesa al pedir.
  -- 'per_table': un QR por mesa que ya dice desde qué mesa se escaneó.
  qr_mode            text NOT NULL DEFAULT 'general'
                     CHECK (qr_mode IN ('general', 'per_table')),
  -- Si es false el comensal no puede enviar pedidos: se los pide al mozo.
  customer_ordering  boolean NOT NULL DEFAULT true,
  -- Guardar en el navegador del comensal los pedidos que hizo.
  customer_history   boolean NOT NULL DEFAULT true,
  table_count        integer NOT NULL DEFAULT 10
                     CHECK (table_count BETWEEN 1 AND 300),
  -- Secreto del QR general (el de cada mesa vive en order_tables).
  general_qr_token   text NOT NULL UNIQUE,
  -- 'shift': el período de trabajo es un turno (según shift_schedule).
  -- 'day': el período de trabajo es el día completo.
  period_mode        text NOT NULL DEFAULT 'shift'
                     CHECK (period_mode IN ('shift', 'day')),
  -- [{ "name": "Mediodía", "from": "11:00", "to": "16:00" }, ...]
  shift_schedule     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Mesas del local. Las que sobran al bajar table_count quedan inactivas (no
-- se borran) para conservar su QR impreso si se vuelven a habilitar.
CREATE TABLE IF NOT EXISTS order_tables (
  id          bigserial PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES order_settings(owner_id) ON DELETE CASCADE,
  number      integer NOT NULL CHECK (number > 0),
  qr_token    text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, number)
);

-- Mozos / camareros. Baja lógica (deleted_at) para no perder el historial
-- de los pedidos que tomaron.
CREATE TABLE IF NOT EXISTS waiters (
  id                  bigserial PRIMARY KEY,
  owner_id            text NOT NULL REFERENCES order_settings(owner_id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  phone               text,
  notes               text,
  active              boolean NOT NULL DEFAULT true,
  -- Código del QR de acceso al tomador de pedidos: rota desde el panel, es
  -- de un solo uso y vence a los pocos minutos. Solo se guarda el hash.
  pairing_code_hash   text UNIQUE,
  pairing_expires_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE INDEX IF NOT EXISTS waiters_owner_idx ON waiters (owner_id) WHERE deleted_at IS NULL;

-- Dispositivos habilitados de cada mozo (celular/tablet que escaneó el QR).
-- El token queda en el localStorage del dispositivo; acá solo su hash.
CREATE TABLE IF NOT EXISTS waiter_sessions (
  id            bigserial PRIMARY KEY,
  waiter_id     bigint NOT NULL REFERENCES waiters(id) ON DELETE CASCADE,
  owner_id      text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS waiter_sessions_waiter_idx ON waiter_sessions (waiter_id) WHERE revoked_at IS NULL;

-- Turnos / días de trabajo. El cierre de caja cierra el turno y congela su
-- resumen. Solo puede haber un turno abierto por local.
CREATE TABLE IF NOT EXISTS shifts (
  id             bigserial PRIMARY KEY,
  owner_id       text NOT NULL REFERENCES order_settings(owner_id) ON DELETE CASCADE,
  label          text NOT NULL,
  opened_at      timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  -- Cierre de caja
  cash_counted   numeric(12, 2),
  closing_notes  text,
  orders_count   integer,
  total_amount   numeric(12, 2)
);
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_owner ON shifts (owner_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS shifts_owner_opened_idx ON shifts (owner_id, opened_at DESC);

-- Pedidos.
CREATE TABLE IF NOT EXISTS orders (
  id                  bigserial PRIMARY KEY,
  owner_id            text NOT NULL REFERENCES order_settings(owner_id) ON DELETE CASCADE,
  shift_id            bigint NOT NULL REFERENCES shifts(id),
  -- Número correlativo dentro del turno (#1, #2...), el que se ve en el panel.
  number              integer NOT NULL,
  -- customer: el comensal desde la carta (QR) · waiter: tomador de pedidos
  -- · panel: cargado a mano desde el panel de pedidos.
  source              text NOT NULL CHECK (source IN ('customer', 'waiter', 'panel')),
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'confirmed', 'ready', 'delivered', 'cancelled', 'returned')),
  table_number        integer CHECK (table_number > 0),
  waiter_id           bigint REFERENCES waiters(id) ON DELETE SET NULL,
  -- Nombre del mozo al momento del pedido (el mozo puede renombrarse o darse de baja).
  waiter_name         text,
  notes               text,
  total               numeric(12, 2) NOT NULL DEFAULT 0,
  -- Anti duplicados / anti bots (solo pedidos de comensales):
  -- client_request_id: id que genera el navegador por envío (reintentos = mismo id).
  -- client_fingerprint: hash del dispositivo, para limitar la frecuencia.
  -- content_hash: hash del contenido, para frenar el mismo pedido dos veces.
  client_request_id   uuid,
  client_fingerprint  text,
  content_hash        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  confirmed_at        timestamptz,
  ready_at            timestamptz,
  delivered_at        timestamptz,
  cancelled_at        timestamptz,
  returned_at         timestamptz,
  UNIQUE (shift_id, number),
  UNIQUE (owner_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS orders_owner_shift_status_idx ON orders (owner_id, shift_id, status);
CREATE INDEX IF NOT EXISTS orders_owner_created_idx ON orders (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_fingerprint_idx ON orders (owner_id, client_fingerprint, created_at DESC)
  WHERE client_fingerprint IS NOT NULL;

-- Líneas del pedido. Dos unidades del mismo producto con aclaraciones
-- distintas ("sin cebolla" / sin aclaración) son dos líneas.
CREATE TABLE IF NOT EXISTS order_items (
  id           bigserial PRIMARY KEY,
  order_id     bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id      text NOT NULL,
  title        text NOT NULL,
  option_name  text,
  unit_price   numeric(12, 2) NOT NULL CHECK (unit_price >= 0),
  quantity     integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  notes        text,
  position     smallint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);
CREATE INDEX IF NOT EXISTS order_items_item_idx ON order_items (item_id);
