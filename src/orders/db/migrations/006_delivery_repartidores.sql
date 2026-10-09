-- ──────────────────────────────────────────────────────────────────────────
-- Delivery / Envíos: repartidores, asignaciones y auditoría.
--
-- Aditiva: no cambia ni borra nada existente (solo amplía el CHECK de
-- actor_type de order_status_events para registrar al repartidor).
--
--  · couriers / courier_sessions: igual que waiters / waiter_sessions. El
--    repartidor no tiene usuario ni contraseña: vincula su celular con un
--    código de un solo uso que vence en minutos y queda un token de sesión.
--  · delivery_assignments: una fila por (pedido, repartidor) a lo largo del
--    tiempo. Solo UNA puede estar activa (assigned / picked_up) por pedido.
--    El código de entrega de 6 dígitos nunca se guarda en claro: HMAC para
--    verificarlo y una copia cifrada (AES-GCM) para que el cliente lo vea.
--  · delivery_events: auditoría (asignaciones, reasignaciones, retiros,
--    entregas, excepciones del administrador y su motivo).
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS couriers (
  id                  bigserial PRIMARY KEY,
  owner_id            text NOT NULL REFERENCES order_settings(owner_id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  phone               text,
  notes               text,
  -- Vinculado y habilitado por el local (el dueño lo puede pausar).
  active              boolean NOT NULL DEFAULT true,
  -- Disponible para recibir entregas ahora (lo cambia el propio repartidor).
  available           boolean NOT NULL DEFAULT false,
  pairing_code_hash   text,
  pairing_expires_at  timestamptz,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS couriers_owner_idx ON couriers (owner_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS couriers_pairing_idx ON couriers (pairing_code_hash) WHERE pairing_code_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS courier_sessions (
  id            bigserial PRIMARY KEY,
  courier_id    bigint NOT NULL REFERENCES couriers(id),
  owner_id      text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  user_agent    text,
  device_label  text,
  courier_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  ended_reason  text
);
CREATE INDEX IF NOT EXISTS courier_sessions_courier_idx ON courier_sessions (courier_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS delivery_assignments (
  id                 bigserial PRIMARY KEY,
  owner_id           text NOT NULL,
  order_id           bigint NOT NULL REFERENCES orders(id),
  courier_id         bigint NOT NULL REFERENCES couriers(id),
  -- Nombre al momento (el repartidor puede renombrarse o darse de baja).
  courier_name       text NOT NULL,
  -- assigned: asignado, falta retirar · picked_up: en camino · delivered:
  -- entregado · released: dejó de ser el responsable (reasignado, anulado…).
  status             text NOT NULL DEFAULT 'assigned'
                     CHECK (status IN ('assigned', 'picked_up', 'delivered', 'released')),
  -- manual: lo asignó el administrador · open: lo tomó el repartidor.
  assigned_via       text NOT NULL CHECK (assigned_via IN ('manual', 'open')),
  assigned_by        text,
  assigned_at        timestamptz NOT NULL DEFAULT now(),
  picked_up_at       timestamptz,
  delivered_at       timestamptz,
  released_at        timestamptz,
  release_reason     text,
  -- Código de entrega (6 dígitos): HMAC para verificar, copia cifrada para
  -- mostrárselo al cliente. Nunca en texto plano.
  code_hash          text,
  code_encrypted     text,
  code_issued_at     timestamptz,
  code_used_at       timestamptz,
  code_failed_attempts integer NOT NULL DEFAULT 0,
  code_locked_until  timestamptz,
  -- courier: confirmó con el código · admin: lo resolvió el administrador.
  delivered_by       text CHECK (delivered_by IN ('courier', 'admin')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- Un pedido tiene a lo sumo una asignación activa: la base lo garantiza aunque
-- dos repartidores intenten tomarlo a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS delivery_assignments_one_active
  ON delivery_assignments (order_id) WHERE status IN ('assigned', 'picked_up');
CREATE INDEX IF NOT EXISTS delivery_assignments_owner_idx ON delivery_assignments (owner_id, status);
CREATE INDEX IF NOT EXISTS delivery_assignments_courier_idx ON delivery_assignments (courier_id, status);
CREATE INDEX IF NOT EXISTS delivery_assignments_order_idx ON delivery_assignments (order_id, created_at);

CREATE TABLE IF NOT EXISTS delivery_events (
  id             bigserial PRIMARY KEY,
  owner_id       text NOT NULL,
  order_id       bigint NOT NULL REFERENCES orders(id),
  assignment_id  bigint REFERENCES delivery_assignments(id),
  -- assigned · reassigned · unassigned · picked_up · delivered · admin_delivered
  -- · released · code_failed · code_locked · code_viewed
  event_type     text NOT NULL,
  actor_type     text NOT NULL CHECK (actor_type IN ('courier', 'panel', 'system')),
  actor_id       text,
  actor_name     text,
  from_courier_id bigint,
  to_courier_id   bigint,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_events_order_idx ON delivery_events (order_id, created_at);
CREATE INDEX IF NOT EXISTS delivery_events_owner_idx ON delivery_events (owner_id, created_at DESC);

-- El repartidor también aparece como autor de un cambio de estado del pedido.
DO $$
DECLARE
  c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'order_status_events'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%actor_type%'
  LOOP
    EXECUTE format('ALTER TABLE order_status_events DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE order_status_events ADD CONSTRAINT order_status_events_actor_type_check
    CHECK (actor_type IN ('customer', 'waiter', 'panel', 'system', 'courier'));
END $$;

-- Nada se borra: bajas lógicas (misma política que el resto del módulo).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['couriers', 'courier_sessions', 'delivery_assignments', 'delivery_events'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_delete', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION orders_prevent_delete()', t || '_no_delete', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION orders_prevent_delete()', t || '_no_truncate', t);
  END LOOP;
END $$;
