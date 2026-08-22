# 🚀 Proyecto Menú Digital

> API multi-tenant para negocios

━━━━━━━━━━━━━━━━━━

# 📅 Dev Log

## 📌 2026-05-12

### ✅ Hecho
- Se agregó la ruta '/api/users/all' con acceso de admin para obtener una lista de todos los usuarios.


## 📌 2026-05-14

### ✅ Hecho
- Se crearon adminRoutes y adminController y se movió la ruta '/api/users/all' dentro, ahora es '/api/admin/allUsers' .
- Se limitó la información del usuario que se envia para las rutas públicas 'api/users/:slug' y 'api/users/:slug/menu' 
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

### ⏳ Pendiente obligatorio
- Confirmar los despliegues de Vercel/Koyeb y ejecutar un pago real con comprador
  distinto del vendedor. Verificar preferencia, `checkout_id`, webhook,
  `PaymentCheckout`, `PaymentTransaction`, alta/plan/vencimiento, CRM, redirección y
  sincronización del dashboard.
- Después del E2E, definir un procedimiento o pantalla para conciliar/reembolsar
  transacciones `not_applied` y la política frente a reembolsos o contracargos.
