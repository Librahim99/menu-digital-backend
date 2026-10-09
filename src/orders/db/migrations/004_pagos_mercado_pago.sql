-- ──────────────────────────────────────────────────────────────────────────
-- Pagos online de pedidos (delivery / take away) con Mercado Pago, cobrando
-- en la cuenta de cada comercio (OAuth). Tarjeta "Feature: Pedidos para
-- delivery o take away con MP". Todo aditivo: no se toca ni renombra nada de
-- las migraciones anteriores ni de la integración de suscripciones.
--
--   · orders.payment_mode / payment_status: el estado del pago va aparte del
--     estado del pedido (pending / confirmed / …). Un pedido pagado no está
--     aceptado por el solo hecho de estar pagado. Los pedidos online se crean
--     recién cuando el pago está aprobado.
--   · order_mp_connections: cuenta de MP conectada por local. Los tokens se
--     guardan CIFRADOS (AES-256-GCM, ver orders/payments/crypto.js); nunca
--     salen en una respuesta de la API.
--   · order_mp_oauth_states: `state` de un solo uso para el callback de OAuth.
--   · order_online_payments: un pago de MP asociado a un pedido.
--   · order_refunds: devoluciones pedidas desde el panel (quién, cuándo,
--     importe, motivo, resultado).
--   · order_mp_webhook_events: notificaciones recibidas, para no procesar dos
--     veces la misma.
--   · Nada se borra en lo que es histórico: mismos triggers que la 002.
-- ──────────────────────────────────────────────────────────────────────────

-- ── Pedidos: modalidad y estado de pago ──────────────────────────────────
-- none        → pedido sin cobro online (flujo de siempre).
-- mercadopago → se cobró online; el pedido nace con payment_status APPROVED y
--               pasa a REFUNDED / PARTIALLY_REFUNDED si se devuelve.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'none';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'NOT_REQUIRED';
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_payment_mode_check
    CHECK (payment_mode IN ('none', 'mercadopago'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
    CHECK (payment_status IN ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED', 'REFUNDED', 'PARTIALLY_REFUNDED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS orders_online_payment_idx ON orders (owner_id, payment_status) WHERE payment_mode = 'mercadopago';

-- ── Cuenta de Mercado Pago conectada por local ───────────────────────────
CREATE TABLE IF NOT EXISTS order_mp_connections (
  id                bigserial PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES order_settings(owner_id),
  mp_user_id        text NOT NULL,                 -- id de la cuenta del vendedor en MP
  -- Cifrados: "iv.authTag.ciphertext" en base64 (orders/payments/crypto.js).
  access_token_enc  text NOT NULL,
  refresh_token_enc text,
  scope             text,
  live_mode         boolean NOT NULL DEFAULT true,
  token_expires_at  timestamptz,                   -- vencimiento del access token
  -- active · revoked (el vendedor revocó desde MP) · disconnected (desde el panel) · error
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'revoked', 'disconnected', 'error')),
  last_error        text,                          -- sin secretos
  connected_at      timestamptz NOT NULL DEFAULT now(),
  disconnected_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- Una sola conexión viva por local.
CREATE UNIQUE INDEX IF NOT EXISTS order_mp_connections_one_active_per_owner
  ON order_mp_connections (owner_id) WHERE status IN ('active', 'error');
-- Una misma cuenta de MP no puede estar viva en dos locales a la vez: evita
-- asociar pagos al negocio equivocado.
CREATE UNIQUE INDEX IF NOT EXISTS order_mp_connections_one_active_per_mp_user
  ON order_mp_connections (mp_user_id) WHERE status IN ('active', 'error');

-- `state` del flujo OAuth: se guarda el hash, vence a los 10 minutos y se usa
-- una sola vez.
CREATE TABLE IF NOT EXISTS order_mp_oauth_states (
  state_hash  text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES order_settings(owner_id),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_mp_oauth_states_owner_idx ON order_mp_oauth_states (owner_id, created_at DESC);

-- ── Pagos online ─────────────────────────────────────────────────────────
-- El pedido NO existe en `orders` hasta que el pago está aprobado: mientras
-- tanto el carrito ya cotizado vive en `draft`. Así un carrito sin pagar no
-- aparece en el tablero, ni suma a la caja o a los reportes. Al aprobarse,
-- el webhook crea el pedido y completa order_id.
CREATE TABLE IF NOT EXISTS order_online_payments (
  id                bigserial PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES order_settings(owner_id),
  order_id          bigint REFERENCES orders(id),
  connection_id     bigint NOT NULL REFERENCES order_mp_connections(id),
  -- Reintentos del mismo envío (doble clic en "Pagar") devuelven el mismo checkout.
  client_request_id uuid,
  -- { serviceType, customer, notes, lines (cotizadas por el servidor), total }
  draft             jsonb NOT NULL,
  checkout_url      text,                                          -- init_point de la preferencia
  preference_id     text,
  -- Lo que viaja a MP como external_reference y vuelve en el pago.
  external_reference text NOT NULL UNIQUE,
  amount            numeric(12, 2) NOT NULL CHECK (amount > 0),   -- cotizado en el servidor
  currency          text NOT NULL DEFAULT 'ARS',
  mp_payment_id     text,                                          -- se completa con el webhook
  status            text NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'REFUNDED', 'PARTIALLY_REFUNDED')),
  mp_status         text,                                          -- estado crudo de MP
  mp_status_detail  text,
  refunded_amount   numeric(12, 2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  approved_at       timestamptz,
  last_event_at     timestamptz,                                   -- fecha del último dato de MP aplicado (fuera de orden)
  expires_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- Un mismo pago de MP no se asocia a dos pedidos.
CREATE UNIQUE INDEX IF NOT EXISTS order_online_payments_mp_payment_uniq
  ON order_online_payments (mp_payment_id) WHERE mp_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS order_online_payments_client_request_uniq
  ON order_online_payments (owner_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_online_payments_order_idx ON order_online_payments (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_online_payments_owner_idx ON order_online_payments (owner_id, created_at DESC);
-- Un pedido tiene a lo sumo un pago vivo (aprobado / devuelto en parte).
CREATE UNIQUE INDEX IF NOT EXISTS order_online_payments_one_live_per_order
  ON order_online_payments (order_id) WHERE order_id IS NOT NULL AND status IN ('APPROVED', 'PARTIALLY_REFUNDED');

-- ── Devoluciones ─────────────────────────────────────────────────────────
-- Una devolución no está COMPLETED hasta confirmar el resultado real en MP.
CREATE TABLE IF NOT EXISTS order_refunds (
  id                  bigserial PRIMARY KEY,
  owner_id            text NOT NULL REFERENCES order_settings(owner_id),
  order_id            bigint NOT NULL REFERENCES orders(id),
  online_payment_id   bigint NOT NULL REFERENCES order_online_payments(id),
  mp_refund_id        text,
  amount              numeric(12, 2) NOT NULL CHECK (amount > 0),
  is_partial          boolean NOT NULL DEFAULT false,
  reason              text,
  status              text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
  failure_detail      text,                        -- sin secretos
  -- Se envía como X-Idempotency-Key: reintentar no duplica la devolución.
  idempotency_key     uuid NOT NULL UNIQUE,
  requested_by_id     text NOT NULL,               -- administrador que la inició
  requested_by_name   text,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_refunds_order_idx ON order_refunds (order_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS order_refunds_payment_idx ON order_refunds (online_payment_id);
-- Evita dos devoluciones en curso sobre el mismo pago.
CREATE UNIQUE INDEX IF NOT EXISTS order_refunds_one_pending_per_payment
  ON order_refunds (online_payment_id) WHERE status = 'PENDING';

-- ── Notificaciones de MP ya recibidas ────────────────────────────────────
-- event_key = hash de (tipo, data.id, x-request-id): un reintento de MP cae
-- en el UNIQUE y no se vuelve a procesar.
CREATE TABLE IF NOT EXISTS order_mp_webhook_events (
  id             bigserial PRIMARY KEY,
  event_key      text NOT NULL UNIQUE,
  topic          text,
  mp_payment_id  text,
  owner_id       text,                              -- se completa al resolver el pago
  outcome        text,                              -- applied · ignored · error
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS order_mp_webhook_events_payment_idx ON order_mp_webhook_events (mp_payment_id);

-- ── Nada se borra ────────────────────────────────────────────────────────
-- Reutiliza orders_prevent_delete() de la 002. Los `state` de OAuth y los
-- eventos de webhook son descartables a futuro, por eso quedan fuera.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'order_mp_connections', 'order_online_payments', 'order_refunds'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION orders_prevent_delete()', t || '_no_delete', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION orders_prevent_delete()', t || '_no_truncate', t);
  END LOOP;
END $$;
