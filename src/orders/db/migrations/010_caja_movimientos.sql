-- ──────────────────────────────────────────────────────────────────────────
-- Circuito de caja: movimientos, arqueo y trazabilidad. Aditiva: no cambia
-- ni borra nada existente.
--
--   · Movimientos de caja (cash_movements): la plata que entra o sale del
--     cajón sin ser una venta (ingresos, egresos, retiros). Hasta ahora un
--     pago a un proveedor aparecía como faltante. Se anulan, nunca se borran.
--     También queda acá cada cambio del fondo inicial (fund_adjustment), que
--     no suma ni resta: es solo el rastro.
--   · Cajero vinculado a un operador (cashier_id) además del nombre, para que
--     los reportes por cajero no dependan de cómo se tipeó.
--   · Quién abrió y quién cerró cada caja.
--   · Cierre con arqueo: lo que se retira al cerrar y lo que queda en el
--     cajón, que es el fondo sugerido de la próxima apertura de esa caja.
--   · El snapshot del cierre suma los movimientos y lo cobrado online.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cash_movements (
  id               bigserial PRIMARY KEY,
  owner_id         text NOT NULL REFERENCES order_settings(owner_id),
  cash_session_id  bigint NOT NULL REFERENCES cash_sessions(id),
  -- income: entra al cajón · expense: sale para pagar algo
  -- · withdrawal: sale pero sigue siendo del local (retiro, depósito)
  -- · fund_adjustment: cambio del fondo inicial (amount = fondo nuevo)
  type             text NOT NULL CHECK (type IN ('income', 'expense', 'withdrawal', 'fund_adjustment')),
  -- Concepto (clave de CASH_MOVEMENT_CATEGORIES en constants.js).
  category         text NOT NULL DEFAULT 'other',
  amount           numeric(12, 2) NOT NULL CHECK (amount >= 0),
  notes            text,
  actor_type       text NOT NULL DEFAULT 'panel',
  actor_id         text,
  actor_name       text,
  idempotency_key  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  voided_at        timestamptz,
  void_reason      text,
  voided_by_name   text,
  UNIQUE (owner_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS cash_movements_session_idx ON cash_movements (cash_session_id, created_at);
CREATE INDEX IF NOT EXISTS cash_movements_owner_idx ON cash_movements (owner_id, created_at DESC);

ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS cashier_id bigint REFERENCES waiters(id);
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS opened_by_type text;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS opened_by_name text;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS closed_by_type text;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS closed_by_name text;
-- Snapshot del cierre
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS income_amount numeric(12, 2);
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS expense_amount numeric(12, 2);
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS withdrawal_amount numeric(12, 2);
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS online_amount numeric(12, 2);      -- cobrado online (no pasa por el cajón)
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS cash_sales_amount numeric(12, 2);  -- ventas que se esperan en efectivo
-- Arqueo: de lo contado, cuánto se retira y cuánto queda para la próxima apertura.
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS cash_withdrawn numeric(12, 2);
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS cash_left numeric(12, 2);

CREATE INDEX IF NOT EXISTS cash_sessions_owner_closed_idx ON cash_sessions (owner_id, closed_at DESC) WHERE closed_at IS NOT NULL;

DROP TRIGGER IF EXISTS cash_movements_no_delete ON cash_movements;
CREATE TRIGGER cash_movements_no_delete BEFORE DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION orders_prevent_delete();
DROP TRIGGER IF EXISTS cash_movements_no_truncate ON cash_movements;
CREATE TRIGGER cash_movements_no_truncate BEFORE TRUNCATE ON cash_movements
  FOR EACH STATEMENT EXECUTE FUNCTION orders_prevent_delete();
