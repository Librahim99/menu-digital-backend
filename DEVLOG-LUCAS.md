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

