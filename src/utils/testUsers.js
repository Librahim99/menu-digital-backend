// Los usuarios de prueba (User.testUser) son cuentas de demo de los
// vendedores: no son clientes y no cuentan en ninguna estadística (métricas
// del admin, cartera del CRM, uso de planes, comisiones). Toda consulta que
// cuente o liste clientes suma este filtro. `$ne: true` y no `false` para que
// también entren las cuentas anteriores al campo, que no lo tienen guardado.
const EXCLUDE_TEST_USERS = Object.freeze({ testUser: { $ne: true } });

module.exports = { EXCLUDE_TEST_USERS };
