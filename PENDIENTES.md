# Pendientes — Menú Digital

Estado al 2026-09-04. Última ronda: se retomaron y cerraron los 5 pendientes de severidad media/baja que habían quedado abiertos en `baja`/`arrepentimiento`/alta de cuentas (rate limiting, precios negativos en variantes, enumeración de cuentas, normalización de username, validación de acceptedTerms/password).

## Backend (`menu-digital-backend`)

**Resuelto en esta sesión** (ver [CLAUDE.md](CLAUDE.md) para el detalle):
- [x] Baja/arrepentimiento sin verificación de identidad (Crítico ×2) — ahora piden código por email antes de ejecutar.
- [x] Reembolso sin idempotencia (Alto) — lock atómico + `idempotencyKey`.
- [x] XSS/SSRF en el PDF vía `Item.image` (Alto) — solo Cloudinary + `escapeHTML()`.
- [x] `solicitarBaja`/`solicitarArrepentimiento` no validaban el *formato* de `contactInfo.mail` — una cuenta con basura ahí (ej. `"ididid"`, visto en producción) llegaba a nodemailer y fallaba con `EENVELOPE "No recipients defined"`, mostrando el 503 genérico en vez de un error claro. Ahora valida formato con el mismo regex que ya usa el frontend, y devuelve 400 explícito.

**Resuelto en la ronda de retomada de pendientes** (165/165 tests):
- [x] **[Medio] Rate limiting en `/baja`, `/arrepentimiento` y sus `/confirmar`** — ahora usan `authLimiter` (10 req/15min), mismo criterio que login.
- [x] **[Medio] `options` acepta precios negativos** — `hasNegativeOptionPrice` en `itemController.js` (`newItem`/`editItem`) + validator a nivel schema en `Item.js` como defensa en profundidad.
- [x] **[Bajo] Enumeración de cuentas** — unificados los dos 404 distintos de `solicitarArrepentimiento` ("no encontramos"/"no pudimos identificar la cuenta") en un solo mensaje genérico, mismo criterio que ya tenía `solicitarBaja`.
- [x] **[Bajo] La baja por `username` nunca matchea si tiene mayúsculas** — resuelto en dos capas: `username` ahora se normaliza a minúsculas al crear la cuenta (`newUser` y `POST /crear-preferencia-registro`, mismo criterio que `contactInfo.mail`), y además `solicitarBaja`/`loginUser` buscan con un regex case-insensitive (`^valor$`, flag `i`, escapado con el `escapeRegex` nuevo en `src/utils/regex.js`) para que las cuentas viejas —creadas antes de este fix, con mayúsculas ya guardadas— también funcionen sin necesitar una migración de datos.
- [x] Validación débil de `acceptedTerms`/password en el alta paga — `!acceptedTerms` (aceptaba cualquier truthy, incluido el string `"false"`) pasó a `acceptedTerms !== true`; el chequeo de password pasó de "solo longitud ≥ 8" a `isWeakPassword` (misma lista de contraseñas comunes que ya usaba el alta gratuita). `isWeakPassword` se extrajo a `src/utils/validators.js` para que ambas altas compartan la misma fuente de verdad.
- [x] Causa raíz del bug de "ididid" — `contactInfo.mail` ahora es obligatorio y se valida formato en los 3 lugares donde se escribe (`newUser`, `POST /crear-preferencia-registro`, `editUser`), más un validator a nivel schema (`User.js`). Cuentas viejas con email inválido ya guardado no se rompen retroactivamente, pero no pueden volver a guardar `contactInfo` hasta corregirlo. Frontend: `Register.tsx` y `UserEditor.tsx` ahora validan formato antes de mandar el request.
- [x] ~~Acción del usuario: cargar `SMTP_USER`/`SMTP_PASS` en Koyeb~~ — confirmado funcionando en producción (envío de prueba real exitoso, 2026-09-04).
- [x] `npm audit fix` parcial — `mongoose` `7.8.9` → `7.8.12` (prototype pollution en el casting de `update`; se confirmó además que ningún controller pasa `req.body` crudo a un write de Mongoose, todos reconstruyen el update con campos explícitos) e `ip-address` `10.2.0` → `10.7.0` (SSRF/trust-boundary bypass; la trae `express-rate-limit`, relevante porque Koyeb corre detrás de un proxy con `trust proxy` activado) más 2 de las 3 copias anidadas de `brace-expansion`. Sin cambios en `package.json` (dentro del rango `^7.3.1` ya declarado), 165/165 tests pasando con las versiones nuevas instaladas de verdad (hubo que forzar un reinstall — `npm install` solo no sincronizó `node_modules` con el lockfile actualizado la primera vez).

**Pendiente:**
- [ ] `npm audit`: 4 vulnerabilidades (1 alta, 3 moderadas) — **sin fix disponible ni con `--force`** (confirmado, no es que no se haya corrido). `qs`/`body-parser` vulnerables vía `express@4.22.2`: la única resolución real requeriría migrar a Express 5.x (cambio mayor, no trivial) o pinnear `qs`/`body-parser` a mano con `overrides` en `package.json` (no se hizo, evaluar aparte). La copia de `brace-expansion` de `nodemon` (solo dev, no se shippea) tampoco tiene upstream fix todavía.

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
- [x] `npm audit fix` del frontend — 8 vulnerabilidades (axios, brace-expansion, browserslist, dompurify, nanoid, postcss, react-router/react-router-dom) resueltas dentro del rango semver ya declarado, sin cambios en `package.json`.
- [x] Rediseño de `UpgradeModal` (hover, animación de entrada, checklist con checkmarks, shadow token correcto).
- [x] Rediseño parcial de `UserDashboard` (hero con foto real del negocio, stats con más presencia visual, descripción de plan simplificada para Pro).
- [x] `FreePlanAd` (banner de publicidad en cartas del plan Free) y el header propio de `UserMenu` (`.mpSticky`) competían por el mismo `position: sticky; top: 0` — el banner (mayor z-index) tapaba el header entero al scrollear. `FreePlanAd` ahora mide su altura real (`ResizeObserver` + `getBoundingClientRect`, no `contentRect` que excluye padding/borde) y la publica como `--free-ad-h`; `.mpSticky` usa `top: var(--free-ad-h, 0px)` para acomodarse debajo sin alturas hardcodeadas.

**Resuelto en la ronda de manejo de errores** (auditoría completa del frontend, `npm run typecheck`/`npm run lint` en 0, probado en navegador con fetch mockeado):
- [x] **"Fetch sin manejar 401"** en `MenuEditor.tsx` (9 funciones: `fetchMenu`, `refetch`, `saveItem`, `confirmDelete`, `toggleItemAvailable`, `handleDrop`, `saveCategoria`, `saveSeccion`, `exportMenu`) y `UserEditor.tsx` (6 funciones: carga inicial, `saveInfo`, `saveTemplate`, `uploadGalleryFiles`, `uploadBackgroundImage`, `removeImage`) — todas desloguean y redirigen a `/login` en 401 en vez de mostrar "no se pudo guardar" sin explicar por qué. De paso, `refetch` en `MenuEditor.tsx` tenía un bug real de fallo silencioso (nunca chequeaba `!res.ok` antes de usar la respuesta). `exportMenuPdf` pega a un endpoint público (carta pública, sin JWT) y no lleva chequeo de 401 a propósito.
- [x] **[Alto] `MassiveImport.tsx` reimplementaba a mano** (`fetch` crudo) las llamadas que ya existían bien resueltas en `src/api/massive.ts` sobre `apiClient` (axios) — reintroducía sesión zombie en 401 y una fuga de `SyntaxError` crudo si el backend devolvía HTML no-JSON. Migrado a `downloadMassiveTemplate`/`previewMassiveImport`/`confirmMassiveImport`/`triggerBlobDownload` de `src/api/massive.ts`: el interceptor global de `apiClient` maneja el 401, y los mensajes reales del backend se extraen con `isAxiosError`.
- [x] **[Medio] Errores de parseo JSON crudos** en `RegisterPlans.tsx` (alta paga/gratuita) y en el polling de `RegisterSuccess.tsx` — ambos con `res.json()`/`response.json()` sin try/catch propio, podían mostrar el texto crudo del parser (`Unexpected token '<'...`) si el backend devolvía HTML (502/504) en vez de JSON. Ahora tienen fallback fijo en español.
- [x] **[Medio] 8 catches con mensaje fijo en vez del real** en `CrmClients.tsx` (carga de clientes, refresh, mover etapa, exportar, guardar perfil CRM, nota, borrar nota, activar/desactivar cuenta) y 1 en `AdminPayments.tsx` — se introdujo `src/lib/apiErrors.ts` (`extractServerMessage`, mismo patrón `isAxiosError` que ya usaban `AdminPlans.tsx`/`AdminSellers.tsx`) y se aplicó en los 9 catches.
- [x] **[Bajo] Catch silencioso** en `AdminLayout.tsx` (badge de seguimientos CRM vencidos) — ahora loguea el error en vez de tragárselo sin rastro (no amerita un banner, es un badge secundario).
- [x] **[Bajo-Medio] Comentario en `client.ts:27`** describía una sincronización entre pestañas (evento `storage`) que no existe — corregido para reflejar el comportamiento real (la redirección en 401 solo limpia la sesión de la pestaña actual); de paso se agregó el `removeItem("tokenExpiry")` que faltaba junto a `token`/`user`.
- [x] **[Bajo] `tokenExpiry` hardcodeado a 7 días** en `AuthProvider.tsx` — ahora se decodifica el payload del JWT (`exp`, sin validar firma — de eso se encarga el backend) en `completeLogin`; el hardcodeo de 7 días queda solo como fallback si el token no trae `exp` decodificable.
- [x] Revisado `Regret.tsx`/`Unsubscribe.tsx` por el patrón de "mensaje del backend reenviado tal cual": confirmado que no hay fuga de texto técnico (el catch externo ya usa un string fijo), el único problema es el ya conocido (mensaje del backend sin filtrar, riesgo de enumeración menor). No requirió cambios.

**Pendiente:**
- [ ] **Rediseño de `UserDashboard`, direcciones no implementadas**: fusionar plan+carta en un solo bloque con stats más grandes, y reordenar por frecuencia de uso (Editor de menú más arriba, plan como badge chico) — se descartaron por riesgo/alcance en esta sesión, quedan como opción futura.
- [ ] **"Mejorar el CSS de todos los componentes" (pedido original del usuario) — todavía sin tocar**: `MenuEditor`, `UserEditor`, `CartDrawer`, `ItemPreviewModal`, `Login`, `Register`, y todo el panel admin (`CEODashboard`, `CrmClients`, `AdminPayments`, `AdminPlans`, `AdminSellers`). Revisados y ya en buen estado (sin cambios pendientes de diseño): `UserMenu`, `UserHome`, `UpgradeModal`, `UserDashboard` (parcial).

---
*Generado automáticamente al cierre de la sesión del 2026-09-04. Si retomás este archivo mucho después, confirmá contra el código actual — puede haber quedado desactualizado.*
