# 🚀 Proyecto Menú Digital

> API multi-tenant para negocios

Revisión documental vigente: **01-09-2026**. Las entradas anteriores conservan su fecha y
sus resultados históricos; no describen necesariamente el código, precios o
despliegue actual. La entrada final registra el contraste más reciente.

La documentación técnica compartida vive en el repositorio frontend:
[arquitectura](../menu-digital-frontend/docs/ARCHITECTURE.md),
[blueprint](../menu-digital-frontend/docs/BLUEPRINT.md) y
[README](../menu-digital-frontend/docs/README.md).
Estos enlaces requieren clonar ambos repositorios como carpetas hermanas.

━━━━━━━━━━━━━━━━━━

# 📅 Dev Log

## 📌 2026-05-12

### ✅ Hecho

- Se agregó la ruta '/api/users/all' con acceso de admin para obtener una lista de todos los usuarios.


## 📌 2026-05-14

### ✅ Hecho

- Se crearon adminRoutes y adminController y se movió la ruta '/api/users/all' dentro, ahora es '/api/admin/allUsers' .
- Se limitó la información del usuario que se envía para las rutas públicas `/api/users/:slug` y `/api/users/:slug/menu`.
- Se creó la ruta '/api/admin/stats' que devuelve métricas generales de la base de datos.
- Se creó la ruta '/api/admin/users/:userID/active' para setear como activo o inactivo un user.
- Se creó la ruta '/api/admin/:userID' para obtener un usuario por ID.


## 📌 2026-08-20

### ✅ Hecho

- Se unificaron los planes comerciales e internos como `free`, `basic` y `pro`, con
  límite gratuito de 15 productos y períodos pagos de 1, 3, 6 y 12 meses.
- Se implementó el alta paga previa a la creación de la cuenta:
  `POST /api/payments/crear-preferencia-registro` guarda un
  `PendingRegistration`, crea la preferencia de MercadoPago y devuelve un token
  opaco para consultar el estado.
- El webhook de MercadoPago quedó como única fuente autorizada para crear la cuenta
  paga o actualizar una suscripción. Verifica firma y estado real del pago.
- Se agregó vigencia de suscripción mediante `subscriptionExpiresAt`; el período se
  calcula en meses calendario y los planes vencidos se exponen como Free.
- Al aprobarse un alta paga se genera el slug, se eliminan las credenciales
  temporales del registro pendiente, se registra el evento en CRM y se habilita el
  login automático del frontend.
- Se agregó `POST /api/payments/registro/estado` para que la pantalla de éxito espere
  la activación del webhook antes de iniciar sesión y redirigir al dashboard.
- En frontend se implementaron `RegisterPlans` y `RegisterSuccess`, conservando el
  plan elegido durante el formulario mediante `?plan=free|basic|pro`.
- La landing comercial ahora muestra Free, Basic y Pro inline. Se eliminó el popup
  de precios y cada tarjeta tiene su CTA: "Crear cuenta" para Free y "Pagar y crear
  cuenta" para Basic/Pro.
- Se verificó el frontend con `typecheck`, `lint`, build y prueba visual responsive.
- Se publicaron los cambios en `master`: frontend `7fdf28d`; backend `761ea26`.
- Se incorporó la programación semanal de disponibilidad por producto para Basic+:
  varios rangos por día, soporte de horarios que cruzan medianoche y cálculo en el
  huso de Buenos Aires. `available` continúa como interruptor manual principal y la
  validación del plan y de los rangos se realiza en backend.
- Se agregó la programación de ofertas por fecha y hora para Basic+, con validación
  centralizada de precios y períodos. La carta web, el PDF y la importación Excel
  comparten ahora el mismo criterio de vigencia y horario argentino.


## 📌 2026-08-22

### ✅ Hecho

- Se conectaron formularios, editores, pagos y paneles al sistema global de
  notificaciones mediante `useFeedbackMessage` y `useAsyncAction`; el cleanup de
  `mountedRef` evita actualizaciones de estado después del desmontaje.
- Se endureció el alta paga: las credenciales temporales se cifran con AES-256-GCM,
  `PendingRegistration` conserva estados propios de MercadoPago y el endpoint de
  estado solo acepta tokens vigentes.
- El frontend puede reanudar un alta después de cerrar o volver a la pestaña, tolera
  errores transitorios durante el polling y solo entrega sesión/redirige cuando el
  registro está realmente `completed`. El login manual también devuelve `slug`.
- Se creó `PaymentTransaction`, historial durable sin TTL e idempotente por
  `paymentID`, con importe, moneda, estado financiero, asociación, plan/período y
  vencimientos anterior/posterior para auditoría y conciliación.
- Se creó `PaymentCheckout`, snapshot durable e inmutable de las condiciones
  ofrecidas antes de abrir MercadoPago. Su `checkout_id` viaja en metadata y permite
  validar asociación, operación, plan, período, importe y moneda originales.
- Los precios backend se centralizaron en `config/paymentPlans.js`: Basic `$2.000`
  y Pro `$5.000`, con períodos de 1/3/6/12 meses y multiplicadores 1/2,7/5/9.
- Upgrades y renovaciones se aplican dentro de una transacción MongoDB. Cada
  `paymentID` diferente extiende una vez desde el vencimiento vigente; un reintento
  del mismo pago no duplica meses.
- Un checkout antiguo no puede degradar un plan superior ni acortar una vigencia
  posterior. Los pagos que no pueden aplicarse quedan auditados como `not_applied`
  para conciliación o reembolso.
- Se mantuvo compatibilidad con preferencias anteriores al snapshot, identificadas
  como `legacy`, y se reforzó la recuperación ante fallos intermedios del webhook.
- La validación local cerró con 53/53 tests backend y con typecheck, lint y build del
  frontend. Los cambios fueron publicados en `master`: frontend `05cd9db`; backend
  `0a6e662`.

### ⏳ Pendientes registrados al 22-08-2026

- Confirmar los despliegues de Vercel/Koyeb y ejecutar un pago real con una cuenta
  compradora distinta de la cuenta vendedora de MercadoPago. Verificar preferencia, `checkout_id`, webhook,
  `PaymentCheckout`, `PaymentTransaction`, alta/plan/vencimiento, CRM, redirección y
  sincronización del dashboard.
- Después del E2E, definir un procedimiento o pantalla para conciliar/reembolsar
  transacciones `not_applied` y la política frente a reembolsos o contracargos.

## 📌 2026-08-30 — Estado contrastado con el código local

### Implementado y conectado

- Planes `free/basic/pro`: límites 15/50/ilimitados, templates 1/5/15,
  Excel/PDF/programación desde Basic y estadísticas/reseñas Pro. Landing pública
  incluida en Free. `getEffectivePlan` aplica vencimientos y `getTemplateForPlan`
  evita exponer diseños por encima del plan efectivo.
- `User` incluye horario del local, Place ID y mensaje de reserva WhatsApp. No hay
  agenda de reservas, consulta de rating Google ni provisión de dominios por tenant.
- `adminPaymentController.js` y `adminPaymentRoutes.js` ofrecen
  `GET /api/admin/payments`, protegido por `protect + isAdmin`: historial durable,
  filtros/paginación, búsqueda y resumen global o por cliente. Es **solo lectura**:
  no consulta pagos a MercadoPago, reembolsa ni modifica suscripciones.
- CRM 360: onboarding calculado, último pago y alertas de pago, vencimientos,
  planes sin fecha, seguimientos y onboarding. Las consultas se agrupan, sin una
  consulta por cliente. El seguimiento del día actual no se considera vencido.
- `getClient` restringe el detalle a clientes no admin; `updateProfile` valida
  fechas y normaliza tags; el admin puede activar/desactivar clientes con registro
  CRM. Los datos internos siguen en `CrmProfile`, separados de `User`.
- `/api/admin/stats` excluye admins de los conteos de usuarios. Frontend consume
  estadísticas, CRM y pagos con `Promise.allSettled` para el resumen CEO.
- Webhook: firma HMAC, separación `live_mode`/`MP_ENV`, snapshot original,
  trazabilidad antes del efecto e idempotencia. Hay regresiones locales para la
  variante del UUID `x-request-id` alterada por Envoy/Koyeb.
- Registro: preferencia de siete días, pending con tres días extra de margen y
  limpieza del registro terminal a las 24 horas. El `sourcePlan` del checkout de
  alta es opcional porque todavía no existe el User.
- Clientes del SDK e idempotency keys por checkout; se comprueban id/init point y
  persistencia de `ready` antes de devolver la URL al frontend.

### Precios y catálogo: distinguir estado actual de implementación parcial

- `src/config/paymentPlans.js` usa Basic **$29.999** y Pro **$49.999 ARS** por mes
  base, con multiplicadores `1/2.7/5/9` para 1/3/6/12 meses. Los $2.000/$5.000 de la
  entrada del 22-08 son históricos. Estos son valores del código local, no precios
  productivos comprobados contra MercadoPago.
- Existen localmente `src/models/Plan.js`, `src/services/planCatalog.js`,
  `src/controllers/planController.js`, `src/routes/planRoutes.js` y
  `src/routes/adminPlanRoutes.js`. `Plan` agrega una colección: es un **cambio de
  arquitectura**, no un reemplazo ya conectado de la configuración estática.
- Modelo: precio regular/promocional, moneda ARS, multiplicadores, actor/fechas y
  concurrencia optimista con `__v`. Beneficios y límites siguen en `config/plans.js`.
- `initializePlans()` usa `$setOnInsert` y no pisa precios/promociones existentes;
  DTO/cotización validan lo persistido y no usan fallback si falla MongoDB.
- **Falta integración:** `app.js` no monta los routers ni invoca el inicializador;
  llama a `connectDB()` sin esperarlo antes de escuchar. Las rutas de pago siguen
  usando `getCheckoutAmount`, no `getCheckoutQuote` ni `planVersion`.
- El frontend tiene clientes/hook y `AdminPlans`, pero no ruta/navegación ni consumo
  del catálogo en pantallas comerciales. Su typecheck falla; no anunciar la edición
  admin de precios como disponible.

### Pendientes comprobados, sin cambios de código en esta revisión

- **PAY-05:** upgrade/renovación no envían expiración de preferencia. Registro sí.
  `PaymentCheckout` aún no tiene `preferenceExpiresAt`. La propuesta es fecha
  inmutable calculada en servidor, sin TTL de auditoría, y pruebas de pagos en el
  límite con notificación tardía. No rechazar un pago aprobado solo por demora del webhook.
- **Editor de productos:** `editItem` no incluye `available`/`hidden` en la whitelist
  del PUT aunque el formulario los envía; los PATCH específicos sí los admiten.
  Fallan dos pruebas locales de persistencia/validación de flags.
- **CRM:** ocultar el botón de borrar eventos en frontend no los vuelve inmutables;
  `deleteNote` elimina por ID sin filtrar `kind` en servidor.
- **Compatibilidad legacy:** el redirect `/:businessName/menu` apunta a
  `/api/menus/public/:slug`, ruta inexistente. La carta actual usa `/api/users/:slug/menu`.
- **Producción:** falta evidencia en esta revisión de deploys, variables remotas,
  preflight del dominio y E2E real autorizado. El CORS local ya contiene
  `https://www.menudigitalapp.com.ar` sin barra final; no incluye apex ni Vercel antiguo.
- **Operación de pagos:** la pantalla de consulta existe; faltan acciones/procedimiento
  de conciliación y reembolso y política frente a contracargos. No se realizaron
  modificaciones de Atlas, precios remotos, pagos, commits ni despliegues.

### Validación reproducida el 30-08-2026

```bash
npm test
```

Resultado: **95 tests, 93 pasan y 2 fallan**, ambos en `test/itemController.test.js`:

1. `editItem persiste disponibilidad, visibilidad y recomendado`.
2. `editItem rechaza estados que no sean booleanos`.

Las 11 pruebas de `test/planCatalog.test.js` pasan, pero ejercitan unidades aisladas;
no prueban montaje HTTP, persistencia real ni integración con MercadoPago. En el
frontend, `typecheck` falla en `AdminPlans.tsx`; lint/build pasan. Las pruebas usan
mocks: no certifican transacciones reales de Atlas, Cloudinary, runtime de Puppeteer
ni el recorrido Checkout Pro → webhook → dashboard.

### Arranque y operación local

- `npm ci` instala desde el lockfile; `npm run dev` usa nodemon y `npm start` Node.
- Configurar variables según `.env.example`, sin copiar secretos a documentación.
  `validateEnvironment()` exige las variables críticas, secretos de al menos 32
  caracteres para JWT/cifrado temporal, coherencia de ambientes y URLs HTTPS en
  producción. Cloudinary también requiere sus credenciales para uploads.
- `GET /` y `/ping` son health checks básicos; no prueban catálogo ni pagos.
- PDF requiere Chrome/Puppeteer operativo; `pdfBrowser.js` reutiliza una instancia
  por proceso. Los rate limiters también son locales a la instancia.
- Nunca registrar cuerpos completos, contraseñas, correos, tokens, Authorization
  ni URLs completas de checkout al investigar un problema de pagos.

## 📌 2026-08-31 — Retiro de dominio propio y reseñas integradas

- Por decisión de producto, ambos beneficios quedan fuera del alcance actual, sin
  compromiso de implementación. Se quitaron de `PLAN_FEATURES` y de la descripción
  comercial de Pro, sin cambiar precios, períodos ni el flujo de pagos.
- Se retiraron los campos de Google del modelo `User` y el control Pro que los
  habilitaba. `getContactInfo` limita las lecturas del panel/landing/carta y las
  ediciones a datos de contacto vigentes, conservando los omitidos en cambios parciales.
- Frontend: se eliminaron campos, validaciones, enlaces, banner, rating y estilos
  de reseñas, y las promesas de ambos beneficios en landing/registro. Maps sigue
  funcionando por dirección; se mantienen WhatsApp, horarios, productos y diseños.
- Se actualizaron los documentos de producto/arquitectura y el resumen comercial.
  No se ejecutó una migración ni limpieza sobre Atlas; los datos históricos pueden
  seguir almacenados, pero no se exponen en las respuestas de contacto indicadas.
- Validación: `test/userContactInfo.test.js` pasa 3/3 (lecturas en los tres planes,
  edición parcial desde clientes antiguos y creación sin los campos retirados).
  Suite completa: 98 tests, 96 pasan y siguen fallando los mismos 2 de `editItem`
  comprobados antes del cambio. Frontend pasa lint/build y conserva el error previo
  de typecheck en `AdminPlans.tsx` por `getPlanFeatureLabel` ausente y tipos derivados.
- QA en navegador local con API simulada y datos temporales: landing comercial,
  página del negocio, carta y edición/guardado de contacto sin campos de reseñas.
  Se verificaron Maps por dirección, WhatsApp y el indicador de producto recomendado.
  El guardado envía solo los campos vigentes. No certifica persistencia real ni producción.
- El nuevo modelo de planes sigue en pausa. Sin commit, push, despliegue ni pagos reales.


## 31-08-2026 — Planes centralizados en MongoDB (integración local)

Cambio de arquitectura solicitado: `plans` pasa a ser la fuente de precios y
beneficios. Se retomó el modelo después del retiro de dominio propio/reseñas;
ambos siguen fuera del producto.

- `Plan.features` obligatorio con booleanos explícitos, `item_limit` positivo o
  null y `templateIds` no vacío. Misma estructura Free/Basic/Pro, sin herencia.
- El arranque espera MongoDB y catálogo válido. `$setOnInsert` conserva valores
  existentes; solo documentos legados sin features reciben el objeto inicial y
  un incremento de versión. No se ejecutó contra una base real.
- Rutas públicas/admin montadas; `/admin/plans` permite editar precios, textos,
  beneficios, límites y diseños. Control de concurrencia y atribución al admin.
- Registro, upgrade y renovación cotizan desde MongoDB y exigen `planVersion`.
  Una versión vieja/ausente devuelve 409 antes de crear preferencia o pending;
  catálogo caído bloquea el cobro, sin precios alternativos. Snapshots históricos
  y webhook se conservan; `PaymentCheckout.planVersion` es inmutable.
- `requireFeature` y controllers validan permisos por petición. Límites, Excel,
  PDF, programación, estadísticas, editor y templates ya no dependen de mínimos
  de plan hardcodeados. Features públicas controlan landing, publicidad y pedidos.
- Los beneficios afectan a usuarios actuales en su siguiente consulta; los
  cambios de precio solo afectan nuevos checkouts. Reducir el límite no borra items.
- Frontend conectado: landing, registro, modal, dashboard, paywalls y templates.
  El administrador recibe una advertencia sobre el efecto en usuarios existentes.
- Validación: frontend typecheck/lint/build pasan. Backend 111/113 tests pasan;
  persisten los mismos dos fallos previos de editItem sobre available/hidden.
  Pruebas nuevas cubren reglas independientes, legado, catálogo caído, conflictos
  y precios dinámicos para 1/3/6/12 meses. Mongoose/MP se simulan; no prueban Atlas.
- Navegador con API aislada en memoria: edición de Pro reflejada en landing y
  dashboard, total de renovación, 409 con reconfirmación, estadísticas desactivadas,
  template retirado y error/reintento de catálogo.
- Sin commit, push, despliegue, consultas productivas ni pagos reales. Pendientes:
  publicación coordinada, revisión del catálogo existente, permisos HTTP/persistencia
  reales y E2E MercadoPago autorizado. PAY-05 sigue separado.

Modelo y estado actual: [ARCHITECTURE.md](../menu-digital-frontend/docs/ARCHITECTURE.md).

## 31-08-2026 — Edición de multiplicadores por plan (local)

- `periodMultipliers` ya se almacenaba en cada documento `Plan` y se usaba para
  cotizar. Ahora se publica como objeto explícito en el catálogo y se puede editar
  por `PATCH /api/admin/plans/:name`, con la misma versión y atribución al admin.
- El mapa exige exactamente 1, 3, 6 y 12 meses, números finitos positivos y sin
  superar la cantidad de meses; el mensual conserva 1 porque define el precio base.
  Con promoción aplicada, cada período pago debe redondear a por lo menos un peso.
  Strings, booleanos y mapas incompletos se rechazan antes de consultar MongoDB.
- Omitir el campo conserva el mapa existente para clientes anteriores. Reiniciar
  o completar features legadas no sobrescribe los multiplicadores administrados.
- Cambiar solamente un multiplicador incrementa la versión y exige reconfirmar
  una cotización vieja. Los checkouts ya creados conservan importe y versión.
- Validación: catálogo/cotizaciones 28/28; suite completa 117/119, con los mismos
  dos fallos previos de `editItem` sobre available/hidden. Pruebas con Mongoose y
  MercadoPago simulados; sin cambios en Atlas, webhook, despliegues ni pagos reales.

## 01-09-2026 — Auditoría de vendedores y códigos (estado no liberable)

La incorporación de `Seller`, `sellerID` en altas/usuarios y el precio especial por
código agrega una colección y cambia el flujo de suscripciones: es un **cambio de
arquitectura**, no un ajuste solo visual.

### Presente y conectado en código

- `Seller` guarda nombre, DNI y código único `AAA-999`; `/api/admin/sellers` ofrece
  CRUD con `protect + isAdmin`. El frontend monta `/admin/sellers` y permite listar,
  crear y editar.
- `POST /api/payments/validate-seller-code` valida el código públicamente. El alta
  paga lo vuelve a comprobar, usa `discountPrice ?? price`, enlaza el vendedor al
  `PendingRegistration` y lo copia al `User` cuando el webhook crea la cuenta.

### Bloqueos encontrados

- **P0 — webhook de cuentas existentes roto:** `applyExistingUserEntitlement`
  referencia `pending` y `paidMonths`, variables inexistentes en ese alcance. Rompe
  upgrades, renovaciones e idempotencia/vencimientos relacionados.
- **P0 — promesa no acreditada:** `RegisterPlans` anuncia siete días de regalo con
  código, pero la rama de alta calcula `subscriptionExpiresAt` solo con los meses
  comprados. La única suma de siete días quedó en la función equivocada anterior.
- **P1 — contrato de precio divergente:** el DTO público sigue usando
  `discountPrice` como `effectivePrice` y alimenta landing/upgrade, mientras
  upgrade/renovación cotizan `price` y solo el alta con vendedor usa la promoción.
  Dos pruebas de catálogo/cotización ya detectan esa diferencia.
- **P1 — sin cobertura nueva:** no hay tests de CRUD, validación de código,
  atribución, precio con/sin vendedor ni bonus. `sellerController.js` tampoco sigue
  `handleError` y devuelve detalles internos de excepciones.
- **P2 — retry ambiguo:** el alta consulta dos veces el mismo vendedor y sobrescribe
  `pending.sellerID` antes de calcular `sameSeller`, por lo que esa comparación no
  protege la atribución previa al reutilizar un checkout.

### Validación reproducida

- Backend: `npm test` → **119 tests, 104 pasan y 15 fallan**. Además de los dos
  fallos históricos de `editItem`, hay tres de promociones/cotización y diez de
  checkout/webhook/vencimientos.
- Frontend: lint pasa. Typecheck y build no resuelven `lucide-react` porque falta en
  el `node_modules` actual, aunque `package.json` y `package-lock.json` lo declaran.
  No se ejecutó `npm ci` sobre la instalación existente.
- No se modificó código funcional, Atlas, MercadoPago, Vercel ni Koyeb durante esta
  auditoría documental. Corregir los P0/P1 y recuperar las suites antes de cualquier
  deploy o E2E real.

## 01-09-2026 — Correcciones por aprobación: Punto 1 completado

Alcance autorizado: reparar únicamente la regresión del webhook de upgrades y
renovaciones, sin adelantar bonus, promociones, dependencias frontend ni edición de
productos.

- En `applyExistingUserEntitlement` se eliminó la inicialización accidental con
  `paidMonths` y el acceso a `pending.sellerID`; ambas variables pertenecen a la rama
  de registro y no existen en esa función. Se restauró `let subscriptionExpiresAt;`.
- Las ramas ya existentes vuelven a decidir el vencimiento con el parámetro `months`:
  recuperación durable, renovación desde la vigencia actual o upgrade sin acortar
  un vencimiento posterior.
- Validación focalizada: `node --test test/paymentWebhook.test.js` → **44/44**.
- Suite completa: `npm test` → **114/119**. Quedan cinco fallos fuera de este punto:
  dos de `editItem` (`available`/`hidden`) y tres de promoción/cotización.
- Sin deploy, consultas a Atlas/MercadoPago ni E2E real. El Punto 2 continúa siendo
  acreditar y probar los siete días extra prometidos por código de vendedor.

## 01-09-2026 — Vista operativa de vendedores y clientes atribuidos

Alcance autorizado: ampliar la administración de vendedores con datos funcionales,
sin agregar colecciones ni modificar el flujo de pagos.

- `GET /api/admin/sellers` conserva el array existente y agrega métricas calculadas
  en lote desde `User.sellerID`: clientes vendidos, cuentas activas, planes pagos
  vigentes, altas/vencimientos a 30 días, vencidos, menú creado, Basic/Pro y última
  alta. Los administradores quedan excluidos.
- `GET /api/admin/sellers/:id` suma un DTO acotado de clientes con negocio, usuario,
  plan almacenado/efectivo, estado, menú, alta y vencimiento. No expone mail,
  teléfono, contacto completo, contraseña ni `sellerID`.
- `sellerController.js` se alineó a CommonJS y `handleError`; dejó de devolver
  `error.message`/`keyValue`. Se retiró del router la importación inexistente y no
  usada de `validateSellerCode`.
- `/admin/sellers` agrega resumen general, búsqueda por nombre/código/DNI, orden,
  copia de código, métricas por tarjeta y detalle bajo demanda con accesos a CRM y
  Pagos. Conserva el CSS Module, tokens `--admin-*` y layout responsive.
- No se muestran conversión, comisiones ni ingresos históricos: Checkout y
  Transaction no conservan un snapshot inmutable del vendedor, por lo que esas
  cifras serían ambiguas.
- Prueba focalizada nueva: `node --test test/sellerController.test.js` → **6/6**.
  Suite completa: `npm test` → **120/125**; permanecen los mismos dos fallos de
  `editItem` y tres de promociones/cotización, fuera de este punto.
- Frontend: typecheck, lint y build pasan. Se restauró únicamente en `node_modules`
  la versión de `lucide-react` ya fijada en package/lock, sin cambios rastreados de
  dependencias.
- El responsable del producto informó que el alta paga y los siete días adicionales
  ya pasaron E2E en el despliegue probado. Esta intervención no repitió el pago ni
  desplegó; reconciliar esa revisión con el worktree queda separado de esta vista.

## 01-09-2026 — Reconciliación de fixes y auditoría de salida a producción

Esta entrada actualiza el estado operativo sin reescribir las revisiones históricas
anteriores. Los resultados corresponden al código y a las referencias Git locales
inspeccionadas; no certifican el entorno desplegado.

### Resuelto y validado localmente

- El contrato de vendedores quedó unificado: `discountPrice` se aplica únicamente
  al registro pago cuando el código ingresado resuelve a un `Seller` válido y deja
  un `sellerID`. Catálogo público, upgrade y renovación conservan el precio regular.
- `editItem` persiste `available`, `hidden` y `recommended`, exige booleanos y
  conserva las verificaciones de pertenencia del producto.
- Backend: `npm test` → **126/126 tests pasan**.
- Frontend: `npm run typecheck`, `npm run lint` y `npm run build` pasan.

### Bloqueos pendientes para producción

- **Inyección/SSRF en PDF:** `Item.image` admite una URL arbitraria y el generador
  la inserta sin escapar en un `<img>` procesado por Puppeteer. Debe restringirse
  el origen/formato de la imagen, escaparse el HTML y probarse el aislamiento antes
  de exponer la generación de PDF en producción.
- **PAY-05 no está en las referencias Git actuales:** no considerar implementada
  la expiración inmutable de siete días ni anunciarla como control activo. Hay que
  restaurar o reimplementar el contrato completo, cubrir retries y pagos aprobados
  tardíos, y validarlo antes del despliegue.
- **Validación del alta paga:** `acceptedTerms` debe aceptar exclusivamente el
  booleano `true`; además, la contraseña debe aplicar la misma política completa
  que el registro gratuito, no solo una longitud mínima.
- **Precios de productos:** `Item.price` todavía admite valores negativos y debe
  rechazarlos tanto en modelo como en las rutas de creación/edición pertinentes.
- **Dependencias:** `npm audit` informa **8 vulnerabilidades en frontend**
  (7 altas y 1 moderada) y **4 vulnerabilidades runtime en backend** (2 altas,
  1 moderada y 1 baja). Las actualizaciones sugeridas deben aplicarse y regresionarse
  de forma controlada; esta auditoría no modificó dependencias.

### Hardening y deuda operativa observada

- Las variables de Cloudinary no forman parte de `REQUIRED_ENV_VARS`, aunque son
  necesarias para el flujo de imágenes.
- La generación de PDF cuenta solo con el rate limiter genérico; falta un límite
  específico acorde a su costo de CPU/memoria.
- Permanecen logs temporales demasiado verbosos en el registro con MercadoPago.
- Hay wrappers de API frontend obsoletos para rutas de menú que ya no coinciden con
  las rutas activas y aparentemente no tienen consumidores; deben eliminarse o
  corregirse después de confirmar su uso.
- El frontend no dispone de una suite automatizada de tests. Typecheck, lint y build
  son controles necesarios, pero no reemplazan regresiones de comportamiento.

### Criterio de liberación

Estado recomendado: **NO-GO**. Antes de salir a producción deben corregirse y
regresionarse los bloqueos anteriores, repetirse las auditorías de dependencias y
ejecutarse E2E reales y autorizados de MercadoPago, MongoDB Atlas, Cloudinary y del
despliegue. En esta revisión no se ejecutaron pagos reales, consultas productivas,
uploads reales ni deploys en Vercel/Koyeb.
