# Pendientes — Menú Digital

Estado al 2026-09-04, después de la sesión que cerró los 2 bugs críticos de `baja`/`arrepentimiento` y arrancó el rediseño del panel. Commits de esta sesión: `d349329` (backend), `dbd093d` (frontend) — ninguno pusheado a remoto todavía.

## Backend (`menu-digital-backend`)

**Resuelto en esta sesión** (ver [CLAUDE.md](CLAUDE.md) para el detalle):
- [x] Baja/arrepentimiento sin verificación de identidad (Crítico ×2) — ahora piden código por email antes de ejecutar.
- [x] Reembolso sin idempotencia (Alto) — lock atómico + `idempotencyKey`.
- [x] XSS/SSRF en el PDF vía `Item.image` (Alto) — solo Cloudinary + `escapeHTML()`.
- [x] `solicitarBaja`/`solicitarArrepentimiento` no validaban el *formato* de `contactInfo.mail` — una cuenta con basura ahí (ej. `"ididid"`, visto en producción) llegaba a nodemailer y fallaba con `EENVELOPE "No recipients defined"`, mostrando el 503 genérico en vez de un error claro. Ahora valida formato con el mismo regex que ya usa el frontend, y devuelve 400 explícito.

**Pendiente:**
- [ ] **[Medio] Sin rate limiting específico en `/baja` y `/arrepentimiento`** — solo tienen el limitador genérico de `/api` (300 req/15min), no el `authLimiter` (10 req/15min) que protege login. El nuevo flujo de código por email ya frena el abuso automático (5 intentos y se invalida), pero conviene sumarlo igual — son rutas que mutan estado de cuenta y disparan reembolsos.
- [ ] **[Medio] `options` (variantes de producto en `Item`) acepta precios negativos** — sin validación en el modelo ni en `itemController.js`, a diferencia de `price`/`offerPrice`.
- [ ] **[Bajo] Enumeración de cuentas** — `solicitarBaja` ya unificó "no existe"/"ya es free" en un único 404 genérico; falta revisar si `solicitarArrepentimiento` y los mensajes del paso de confirmación tienen el mismo cuidado.
- [ ] **[Bajo] La baja por `username` nunca matchea si tiene mayúsculas** — se busca con `.toLowerCase()` pero el username no se normaliza al crear la cuenta (alta gratuita ni paga).
- [ ] Validación débil de `acceptedTerms` y de password en el alta paga (`PendingRegistration`) — señalado en `DEVLOG-LUCAS.md`.
- [x] **Causa raíz del bug de "ididid" — resuelta**: `contactInfo.mail` ahora es obligatorio y se valida formato en los 3 lugares donde se escribe (`newUser`, `POST /crear-preferencia-registro`, `editUser`), más un validator a nivel schema (`User.js`) como defensa en profundidad. Cuentas viejas con email inválido ya guardado no se rompen (los validators de Mongoose solo corren sobre campos que un write realmente toca), pero no pueden volver a guardar `contactInfo` hasta corregirlo. Frontend: `Register.tsx` y `UserEditor.tsx` ahora validan formato antes de mandar el request (antes solo chequeaban que no esté vacío, con `noValidate` en el form).
- [ ] `npm audit`: 6 vulnerabilidades (2 altas, 4 moderadas), todas con `fixAvailable: true` — falta correr `npm audit fix`.
- [x] ~~Acción del usuario: cargar `SMTP_USER`/`SMTP_PASS` en Koyeb~~ — confirmado funcionando en producción (envío de prueba real exitoso, 2026-09-04).

**Ideas para Estadísticas (Pro) — discutidas, no implementadas**, ordenadas por costo:
- [ ] Comparación vs. período anterior (+X% vs. los 30 días previos) — con datos que ya existen.
- [ ] Tendencia de 7 días (↑/↓) — se calcula del lado del cliente con `last30Days`.
- [ ] Mejor día de la semana — agrupar `last30Days` por día.
- [ ] Vistas por categoría (no solo por producto) — reagrupar `ItemView`.
- [ ] Exportar CSV del historial — solo frontend.
- [ ] Franja horaria de mayor tráfico — **requiere sumar granularidad horaria** a `PageView`/`ItemView` (hoy solo guardan un contador por día).
- [ ] Tasa de conversión vista → pedido por WhatsApp — **requiere un endpoint de tracking nuevo**, el botón "Pedir por WhatsApp" hoy es un `<a href>` directo sin avisar al backend. La más valiosa de las seis, también la de más trabajo.

## Frontend (`menu-digital-frontend`)

**Resuelto en esta sesión:**
- [x] `AuthProvider.refreshUser`, `UserDashboard`, `UpgradeModal`, `UserStats` no manejaban sesión vencida (401) — corregido en los cuatro.
- [x] `CartProvider.addItem` facturaba al precio viejo al fusionar una línea existente (Alto).
- [x] `CartProvider` no validaba el esquema de lo leído de `localStorage`.
- [x] `UpgradeModal` no manejaba errores de parseo JSON (respuesta no-JSON mostraba el `SyntaxError` crudo).
- [x] `Regret.tsx`/`Unsubscribe.tsx` actualizados al flujo de confirmación por código.
- [x] Rediseño de `UpgradeModal` (hover, animación de entrada, checklist con checkmarks, shadow token correcto).
- [x] Rediseño parcial de `UserDashboard` (hero con foto real del negocio, stats con más presencia visual, descripción de plan simplificada para Pro).

**Pendiente:**
- [ ] **El mismo patrón de "fetch sin manejar 401"** sigue en `MenuEditor.tsx` y `UserEditor.tsx` — no se tocaron en esta sesión.
- [ ] **[Medio] Errores de parseo JSON crudos** en `RegisterPlans.tsx:233-234,282-284` — mismo bug que se arregló en `UpgradeModal`, ahí sigue.
- [ ] **[Medio] Mensaje de error del backend reenviado tal cual** en `Regret.tsx`/`Unsubscribe.tsx` (`data.message` directo al usuario) — riesgo de enumeración; menor ahora que los mensajes del backend son más genéricos, pero el patrón no cambió.
- [ ] **[Bajo-Medio] Comentario en `client.ts:27` describe una sincronización entre pestañas (evento `storage`) que no existe en el código.**
- [ ] **[Bajo] `tokenExpiry` hardcodeado a 7 días** en el cliente (`AuthProvider.tsx`), no derivado del JWT real.
- [ ] `npm audit`: 8 vulnerabilidades (7 altas, 1 moderada) — axios y react-router-dom desactualizados, ya resuelto en su propio rango semver (`npm audit fix`/`npm update` alcanza).
- [ ] **Rediseño de `UserDashboard`, direcciones no implementadas**: fusionar plan+carta en un solo bloque con stats más grandes, y reordenar por frecuencia de uso (Editor de menú más arriba, plan como badge chico) — se descartaron por riesgo/alcance en esta sesión, quedan como opción futura.
- [ ] **"Mejorar el CSS de todos los componentes" (pedido original del usuario) — todavía sin tocar**: `MenuEditor`, `UserEditor`, `CartDrawer`, `ItemPreviewModal`, `Login`, `Register`, y todo el panel admin (`CEODashboard`, `CrmClients`, `AdminPayments`, `AdminPlans`, `AdminSellers`). Revisados y ya en buen estado (sin cambios pendientes de diseño): `UserMenu`, `UserHome`, `UpgradeModal`, `UserDashboard` (parcial).

---
*Generado automáticamente al cierre de la sesión del 2026-09-04. Si retomás este archivo mucho después, confirmá contra el código actual — puede haber quedado desactualizado.*
