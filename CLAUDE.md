# Menú Digital — contexto del proyecto

SaaS para que restaurantes gestionen un menú digital (carta pública + panel de administración), con planes pagos por suscripción vía Mercado Pago. Son **dos repositorios hermanos**, cada uno con su propio git:

- **Backend** (este repo): `C:\Users\Thomas\OneDrive\Documentos\GitHub\menu-digital-backend` — API REST. Desarrollo en `codex/desarrollo`, pero **Koyeb despliega desde `master`** (no desde `codex/desarrollo` — corregido acá porque este doc lo tuvo mal documentado un tiempo). Todo cambio de producción necesita llegar a `master`, no alcanza con mergearlo solo a `codex/desarrollo`.
- **Frontend**: `../menu-digital-frontend` (`C:\Users\Thomas\OneDrive\Documentos\GitHub\menu-digital-frontend`) — SPA.

Producción: backend en **Koyeb** (`https://menu-digital-backend.koyeb.app`), frontend en **Vercel** (`https://www.menudigitalapp.com.ar`), que reescribe `/api/:path*` hacia el backend (`vercel.json`).

**Para más detalle que este resumen no cubre, leer directamente:**
- [`DEVLOG-LUCAS.md`](DEVLOG-LUCAS.md) (este repo) — changelog fechado y auditado: qué está hecho, roto o pendiente, con validación reproducida.
- `../menu-digital-frontend/docs/README.md` — estado del frontend y bloqueos de producción.
- `../menu-digital-frontend/docs/ARCHITECTURE.md` — recorrido archivo por archivo del frontend (1400 líneas).
- `../menu-digital-frontend/docs/BLUEPRINT.md` — producto, pricing y roadmap.

## Stack técnico

| | Backend | Frontend |
|---|---|---|
| Runtime | Node.js + Express 4.18 | — |
| Lenguaje | JavaScript (sin TS) | TypeScript ~6.0 |
| Framework/build | — | React 19.2 + Vite 8 |
| DB / datos | MongoDB Atlas + Mongoose 7.3 | React Query v5 (estado servidor) + Context API (estado app) |
| Routing | Express Router | react-router-dom v7, rutas lazy |
| Estilos | — | CSS Modules + tokens en `src/styles/globals.css` |
| Auth | JWT (jsonwebtoken) + bcryptjs | Token/usuario en `localStorage` vía `AuthContext` |
| Pagos | `mercadopago` SDK v3 | — (redirige a `init_point` de MP) |
| Otros | Cloudinary+multer (imágenes), exceljs (carga masiva), puppeteer (PDF del menú), helmet, cors, express-rate-limit, express-mongo-sanitize | axios, framer-motion, jspdf+qrcode (QR del menú), lucide-react |

Ninguno de los dos repos tiene `README.md` en la raíz — el backend usa `DEVLOG-LUCAS.md`, el frontend usa `docs/`.

## Estructura del backend

Entry point `src/app.js`. Organización por capas: `src/config` (`db.js`, `environment.js` valida env vars al boot, `plans.js` reglas de negocio de planes, `paymentPlans.js` precios/duraciones MP, `cloudinary*.js`), `src/controllers`, `src/routes`, `src/models`, `src/middleware` (`auth.js`, `rateLimiters.js`), `src/services/planCatalog.js`, `src/utils/*`. Tests en `/test` (raíz, no `src/test`). **No hay cron/jobs programados** — todo cálculo de vencimiento de plan es "lazy" (se recalcula en cada request, ver más abajo).

## Estructura del frontend

- `src/components/Admin/` — panel interno CEO: ojo, `Home/AdminHome.tsx` es la **landing pública comercial** en `/`, no un panel; el dashboard interno real es `Panel/CEODashboard.tsx`. Incluye CRM, pagos (solo lectura), catálogo de planes, vendedores.
- `src/components/User/` — panel del dueño de restaurante (`Panel/Dashboard/UserDashboard.tsx`, editor de menú, stats) y la carta pública del cliente final (`Home/Home/UserHome.tsx`, `Home/Menu/UserMenu.tsx` + carrito).
- `src/components/Register/`, `src/components/Login/`, `src/components/Common/` (`UpgradeModal.tsx`, `FreePlanAd.tsx`, etc).
- `src/pages/Legal/` — Contact, Privacy, Terms, **Regret.tsx** ("Arrepentimiento"), **Unsubscribe.tsx** ("Baja") — todas públicas, sin login.
- `src/routes/AppRoutes.tsx` (tabla central) + `AdminRoutes.tsx`/`UserRoutes.tsx` (guards por rol).
- `src/lib/plans.ts` (orden/labels de plan, `isSubscriptionExpired`), `src/lib/whatsapp.ts` (el "checkout" del cliente final es un pedido armado por WhatsApp, no un pago), `src/types/index.ts` (espejo de los schemas Mongoose del backend).

## Modelo de dominio (backend, campos reales)

- **User**: `username`, `slug`, `password` (hash bcrypt), `active`, `admin`, `subscription` (free/basic/pro), `subscriptionExpiresAt`, `sellerID`, `hasDelivery`, `template`, `contactInfo{...}`, `media{...}`, `schedule{mon..sun}`.
- **Plan**: `name` (enum único), `price`, `discountPrice`, `features` (9 booleans + `item_limit` + `templateIds[]`), `periodMultipliers` (1/3/6/12 meses), versión optimista. Editable por admin (`PATCH /api/admin/plans/:name`), catálogo vive en Mongo (`src/services/planCatalog.js`).
- **PaymentCheckout**: snapshot inmutable pre-pago (`preferenceId`, `operation`, `planId`, `months`, `expectedAmount`, `status`).
- **PaymentTransaction**: historial durable (`paymentID` único, `entitlementStatus`, `checkoutValidation`, y los campos agregados recientemente `refunded/refundedAt/refundId`).
- **PendingRegistration**: alta paga antes de crear el `User`, password cifrada AES-256-GCM, TTL.
- **Menu** / **Item** (precio, `offerPrice`, `availabilitySchedule`, `isExtra`, `hidden`), **Seller** (códigos de descuento formato `AAA-999`), **CrmProfile** (stage lead/onboarding/activo/en_riesgo/baja — separado de `User` a propósito), **ItemView/PageView** (contadores para stats del plan Pro).

## Autenticación

JWT (HS256). `src/middleware/auth.js`: `protect` valida el bearer token y **recalcula el plan efectivo en cada request** (`getSubscriptionState`), `isAdmin`, `requireFeature(feature)` → 403 `FEATURE_NOT_INCLUDED`. Sin sesiones ni refresh tokens. Frontend guarda `token`/`user`/`tokenExpiry` en `localStorage` (`AuthProvider`), resincroniza en focus/visibilitychange y con un `setTimeout` calculado para el instante exacto de vencimiento del plan.

## Sistema de planes, baja y arrepentimiento (foco de trabajo reciente)

El downgrade al vencer **no es un cron**: `getEffectivePlan`/`getSubscriptionState` (`src/config/plans.js`) recalculan el estado en cada lectura. El commit `1bce605` ("fix downgrade de plan al vencer") propagó ese cálculo de forma consistente a `middleware/auth.js` + 6 controllers, antes inconsistente entre endpoints.

**Baja y arrepentimiento** (`ff7f7dc`, `9cd9001` — backend; `cf636b3`, `331cf7e` — frontend): son páginas **públicas sin login**, tipo "ticket de soporte" (no un toggle en el dashboard). Son un flujo de **2 pasos con confirmación por email** (rediseñado tras una auditoría: la versión original ejecutaba la baja/reembolso solo con el email tipeado por quien pedía la acción, sin probar que lo controlara — cualquiera podía sabotear la cuenta de otro):
1. `POST /api/payments/baja` / `POST /api/payments/arrepentimiento` — validan que haya algo que accionar (cuenta paga existente / transacción aprobada dentro de los 10 días corridos, Ley 24.240 + Disp. 954/2025) pero **no ejecutan nada todavía**. Crean un `PendingServiceAction` (`src/models/PendingServiceAction.js`, TTL 15 min, máx. 5 intentos) y mandan un código de 6 dígitos al email **real** de la cuenta (nunca al que haya tipeado quien pide la acción) vía `src/utils/mailer.js` (nodemailer, Gmail SMTP — variables `SMTP_USER`/`SMTP_PASS`). Responden `{ requiresConfirmation: true, requestId, maskedEmail }`.
2. `POST /api/payments/baja/confirmar` / `POST /api/payments/arrepentimiento/confirmar` (`{ requestId, code }`) — recién acá se ejecuta: baja el `User` a free (baja) o ejecuta `PaymentRefund` de MP con `idempotencyKey` + lock atómico contra doble reembolso, marca `refunded/refundedAt/refundId` (arrepentimiento). El claim del código es atómico (`findOneAndUpdate consumed:false→true`) para que un reenvío/doble-submit no repita la acción.

Ambos devuelven un código de referencia (`BAJA-…`/`ARR-…`) y loguean el evento en `CrmProfile`. El dashboard autenticado (`UserDashboard.tsx`) solo *refleja* el resultado (banner con `previousSubscription`/`downgradeReason`/`subscriptionStatus`), no dispara la baja. Tests: `test/serviceActions.test.js`.

## Integración de pagos (Mercado Pago)

Webhook `POST /api/payments/webhook` (`mpWebhook`): valida firma HMAC-SHA256 (`x-signature`/`x-request-id`, con fallback por un bug conocido de Envoy/Koyeb) contra `MP_WEBHOOK_SECRET`, exige coherencia `NODE_ENV`↔`MP_ENV`↔`live_mode`, idempotente por `paymentID`, aplica entitlements dentro de una transacción Mongo. Ventana de preferencia: 7 días.

## Comunicación frontend ↔ backend — cuidado, hay 3 mecanismos distintos

1. `src/api/client.ts` (axios, `baseURL: VITE_API_URL`, interceptor de auth + logout en 401) — la mayoría de `src/api/*.ts`.
2. `src/api/apiClient.ts` (wrapper propio sobre `fetch`, `ApiError` tipado) — usado solo por `plans.ts`.
3. `fetch('/api/...')` **relativo**, sin pasar por ninguno de los dos clientes — en `UpgradeModal.tsx`, `UserDashboard.tsx`, `Regret.tsx`, `Unsubscribe.tsx`. Funciona por el proxy de Vite en dev y el rewrite de `vercel.json` en prod, pero es inconsistente (el propio `docs/README.md` del frontend lo señala como deuda).

## Rutas de API principales (backend)

`/api/users` (registro/login/perfil + público `/:slug`, `/:slug/menu`, `/:slug/menu/pdf`) · `/api/menus`, `/api/items` (tras `requireFeature("menu_editor")`) · `/api/massive` (Excel) · `/api/plans` (público) y `/api/admin/plans` (CRUD) · `/api/payments` (`crear-preferencia`, `crear-preferencia-registro`, `validate-seller-code`, `arrepentimiento`, `baja`, `registro/estado`, `webhook`) · `/api/admin` (`allUsers`, `stats`, `:userID`), `/api/admin/crm`, `/api/admin/payments` (solo lectura), `/api/admin/sellers` · `/ping`, `/` (health).

## Variables de entorno (nombres, sin valores)

**Backend** (`.env.example`): `NODE_ENV`, `PORT`, `MONGODB_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `PENDING_REGISTRATION_SECRET`, `ACCEPTED_TERMS_VERSION`, `FRONTEND_URL`, `MP_ENV`, `MP_ACCESS_TOKEN`, `MP_WEBHOOK_URL`, `MP_WEBHOOK_SECRET`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `SMTP_USER`, `SMTP_PASS` (Gmail SMTP para los códigos de confirmación de baja/arrepentimiento — sin esto el arranque no falla, pero esos dos endpoints responden 503).
**Frontend**: solo `VITE_API_URL` (recomendado `/api` incluso en local, para depender del proxy de Vite).

## Scripts

**Backend**: `npm start` (`node src/app.js`), `npm run dev` (nodemon), `npm test` (`node --test`).
**Frontend**: `npm run dev` (vite), `npm run build`, `npm run typecheck` (`tsc -b`), `npm run lint`, `npm run preview`. **Sin script `test`** (no hay framework de testing instalado en el frontend).

## Testing

Backend: 20 archivos en `/test`, runner nativo `node:test`, controllers testeados directo con mocks in-process de Mongoose y del SDK de `mercadopago` (sin supertest/jest/mongodb-memory-server). Frontend: sin testing automatizado — bloqueo de producción documentado.

## Deployment

Sin `Dockerfile` ni `.github/workflows` en ninguno de los dos repos. Backend en Koyeb (`trust proxy` activado, workaround para bug de x-request-id de Envoy), CORS habilita `https://www.menudigitalapp.com.ar` + localhost. Frontend en Vercel vía `vercel.json`.

## Bloqueos de producción conocidos (no resueltos a la fecha de este doc)

Según `DEVLOG-LUCAS.md` y `docs/README.md` del frontend, estado **NO-GO** por:
- ~~SSRF/XSS en la generación de PDF del menú~~ **Resuelto**: `Item.image`/`Menu.image` ahora validan que sean una URL de Cloudinary (`src/utils/imageUrl.js`), y `menuPdfTemplate.js` escapa el valor igual antes de insertarlo en el `src` del `<img>` (defensa en profundidad). Tests en `test/imageUrlValidation.test.js`.
- ~~Validación débil de `acceptedTerms` y de password en el alta paga~~ **Resuelto** (ver `PENDIENTES.md`).
- ~~`Item.price` acepta valores negativos~~ **Resuelto**: validator de schema + chequeos en `itemController`, y la importación masiva pasa `runValidators: true` (era el único camino que se los salteaba).
- Vulnerabilidades de `npm audit`: quedan 4 en el backend **sin fix upstream disponible** (`qs`/`body-parser` vía `express@4`); se verificó que no son explotables con la configuración actual, que no activa las opciones que las disparan. Frontend en 0.
- Falta de testing automatizado en el frontend (sigue vigente).

Antes de tocar generación de PDF, alta de usuarios o validación de `Item`, revisar el estado actual de estos puntos en `PENDIENTES.md`, que se mantiene más al día que este resumen.

**Subida de imágenes**: hay tres endpoints, todos autenticados — `POST /api/items/:itemID/upload-image` (imagen de un producto existente), `POST /api/items/upload-image` (imagen todavía sin producto: el editor la pide antes de crearlo) y los de `/api/users` para galería y portada. El frontend **no** debe subir directo a Cloudinary: hubo un preset sin firmar embebido en el bundle que dejaba escribir en la cuenta sin autenticación, y se eliminó.

## Convenciones

Commits y nombres de ramas en español (`codex/desarrollo`, `rama-version-1-9-26`); PRs se mergean a `master`. Ambos repos evolucionan en paralelo para la misma feature (ver commits del 02–04/09/2026 sobre downgrade/baja/arrepentimiento en ambos repos casi en simultáneo) — al tocar planes/pagos, revisar si el cambio necesita contraparte en el otro repo.

---
*Generado el 2026-09-04 explorando ambos repos. Si algo de acá quedó desactualizado, confiar en el código y en `DEVLOG-LUCAS.md`/`docs/` antes que en este resumen.*
