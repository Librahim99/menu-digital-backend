-- ──────────────────────────────────────────────────────────────────────────
-- Repartidores: código corto para vincular el celular sin escanear el QR.
--
-- Es la misma invitación que el QR (comparten vencimiento y uso único): el QR
-- trae un token largo y, a mano, se tipean 8 caracteres (ABCD-EFGH). Solo se
-- guarda su hash. Aditiva e idempotente.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE couriers ADD COLUMN IF NOT EXISTS pairing_manual_hash text;
CREATE INDEX IF NOT EXISTS couriers_pairing_manual_idx ON couriers (pairing_manual_hash) WHERE pairing_manual_hash IS NOT NULL;
