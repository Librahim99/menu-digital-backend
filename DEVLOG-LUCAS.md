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

### ⚠️ Pendiente
- El circuito Free está listo y redirige al dashboard con sesión iniciada.
- En producción, el alta Basic/Pro llega a
  `/api/payments/crear-preferencia-registro` pero responde 500 con
  `No se pudo crear la preferencia de pago`. El próximo paso es revisar el error
  interno en los logs de Koyeb para determinar si falla el guardado del
  `PendingRegistration` o la creación de la preferencia en MercadoPago.
