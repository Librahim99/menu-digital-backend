-- ──────────────────────────────────────────────────────────────────────────
-- Delivery: marca de "el pedido salió del local" (entre Listo y Entregado).
--
-- No es un estado nuevo: el pedido sigue en "ready" hasta que se entrega. Solo
-- se registra a qué hora salió. Se considera "en camino" únicamente si esa hora
-- es posterior a la última vez que el pedido pasó a "ready" (si vuelve atrás y
-- se lo marca listo de nuevo, deja de figurar como en camino sin tener que
-- limpiar nada). Aditiva: no cambia ni borra nada existente.
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;
