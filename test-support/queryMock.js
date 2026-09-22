"use strict";

// ──────────────────────────────────────────────
// Query mock para tests de controllers que encadenan
// Model.find(...).select(...).sort(...).lean().batchSize(...).
//
// Vive FUERA de test/ a propósito: `node --test` corre como test cualquier
// .js que esté dentro de test/, y esto es un helper, no un test.
//
// Los mocks históricos del repo devuelven una Promise nativa
// (`async () => valor`), que no tiene .select/.sort/.lean: no sirven para un
// handler que encadena. Esta query es "thenable" (se puede await-ear y pasar
// a Promise.all) y además:
//   - REGISTRA lo que el handler pidió (filtro, select, sort, lean,
//     batchSize, limit) para poder assertarlo.
//   - APLICA de verdad el filtro (igualdad, $in, $ne, $nin), el orden y la
//     proyección (inclusión o exclusión, con rutas con punto). Así un campo
//     olvidado en el select desaparece del resultado y el test lo detecta,
//     cosa que un mock que devuelve el documento entero nunca haría.
//   - Con lean() devuelve objetos planos (toObject con flattenMaps, como los
//     que entrega Mongo); sin lean() y con un modelo, hidrata con
//     Model.hydrate(doc, proyección), o sea un documento Mongoose que solo
//     tiene los campos seleccionados y sus defaults, como en producción.
//
// Uso:
//   const calls = mockQuery(t, Item, "find", items);
//   await handler(req, res);
//   assert.deepEqual(calls[0].filter, { ... });
//   assert.equal(calls[0].select, "title price");
//   assert.deepEqual(calls[0].sort, { _id: 1 });
// `rows` puede ser un array/documento (se filtra con el filtro pedido) o una
// función (filter, call) => filas/documento, que además puede tirar para
// simular una caída de Mongo (el error llega como rechazo del await).
// ──────────────────────────────────────────────

const SINGLE_METHODS = new Set(["findOne", "findById"]);

const isOperatorObject = (condition) => condition !== null
  && typeof condition === "object"
  && !(condition instanceof Date)
  && Object.keys(condition).length > 0
  && Object.keys(condition).every((key) => key.startsWith("$"));

const toSource = (row) => (typeof row?.toObject === "function"
  ? row.toObject({ flattenMaps: true })
  : row);

const getPath = (source, parts) => {
  let current = source;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
};

// Mongo trata `{ campo: null }` como "null o ausente". El resto se compara por
// su representación en texto: así un ObjectId, su hex y un string coinciden.
const sameValue = (value, expected) => {
  if (expected === null) return value === null || value === undefined;
  if (value === null || value === undefined) return false;
  return String(value) === String(expected);
};

const matchesCondition = (value, condition) => {
  if (!isOperatorObject(condition)) return sameValue(value, condition);
  return Object.entries(condition).every(([operator, expected]) => {
    switch (operator) {
      case "$in": return expected.some((candidate) => sameValue(value, candidate));
      case "$nin": return !expected.some((candidate) => sameValue(value, candidate));
      case "$ne": return !sameValue(value, expected);
      default: throw new Error(`queryMock: operador no soportado ${operator}`);
    }
  });
};

const matchesFilter = (row, filter) => {
  const source = toSource(row);
  return Object.entries(filter ?? {}).every(([path, condition]) => {
    if (path.startsWith("$")) throw new Error(`queryMock: operador de filtro no soportado ${path}`);
    return matchesCondition(getPath(source, path.split(".")), condition);
  });
};

const sortValue = (value) => {
  if (value instanceof Date) return value.getTime();
  // Los ObjectId comparan por su hex, que ordena igual que el orden de Mongo.
  if (value !== null && typeof value === "object") return String(value);
  return value;
};

const compareBy = (sort) => (rowA, rowB) => {
  const a = toSource(rowA);
  const b = toSource(rowB);
  for (const [path, direction] of Object.entries(sort)) {
    const valueA = sortValue(getPath(a, path.split(".")));
    const valueB = sortValue(getPath(b, path.split(".")));
    if (valueA === valueB) continue;
    if (valueA === undefined || valueA === null) return -direction;
    if (valueB === undefined || valueB === null) return direction;
    return (valueA < valueB ? -1 : 1) * direction;
  }
  return 0;
};

// Junta todos los .select() del handler en una sola proyección. Mongo no deja
// mezclar inclusión y exclusión (salvo _id): el mock tampoco.
const parseProjection = (selects) => {
  const include = new Set();
  const exclude = new Set();
  for (const select of selects) {
    if (typeof select === "string") {
      for (const token of select.split(/\s+/).filter(Boolean)) {
        if (token.startsWith("+")) continue; // fuerza un select:false: no cambia la proyección
        if (token.startsWith("-")) exclude.add(token.slice(1));
        else include.add(token);
      }
    } else if (select && typeof select === "object") {
      for (const [path, value] of Object.entries(select)) {
        (value ? include : exclude).add(path);
      }
    }
  }
  const idExcluded = exclude.delete("_id");
  if (include.size > 0 && exclude.size > 0) {
    throw new Error("queryMock: no se puede mezclar inclusión y exclusión en un select");
  }
  return { include: [...include], exclude: [...exclude], idExcluded };
};

const cloneShallow = (value) => (Array.isArray(value) ? [...value] : { ...value });

// Copia con lo excluido quitado, sin tocar el documento original.
const omitPath = (source, parts) => {
  const [head, ...rest] = parts;
  if (source === null || typeof source !== "object" || !(head in source)) return source;
  const copy = cloneShallow(source);
  if (rest.length === 0) delete copy[head];
  else copy[head] = omitPath(source[head], rest);
  return copy;
};

const applyProjection = (source, projection) => {
  const { include, exclude, idExcluded } = projection;
  if (include.length === 0 && exclude.length === 0 && !idExcluded) return source;

  if (include.length > 0) {
    // Si se pidió `contactInfo` y `contactInfo.number`, alcanza con el padre.
    const paths = include.filter((path) => !include.some((other) => other !== path && path.startsWith(`${other}.`)));
    const picked = {};
    if (!idExcluded && source._id !== undefined) picked._id = source._id;
    for (const path of paths) {
      const parts = path.split(".");
      const value = getPath(source, parts);
      if (value === undefined) continue;
      let target = picked;
      for (const part of parts.slice(0, -1)) {
        if (target[part] === undefined) target[part] = {};
        target = target[part];
      }
      target[parts[parts.length - 1]] = value;
    }
    return picked;
  }

  let result = source;
  for (const path of [...exclude, ...(idExcluded ? ["_id"] : [])]) {
    result = omitPath(result, path.split("."));
  }
  return result;
};

// Proyección para Model.hydrate. Mongo devuelve `_id` en una proyección de
// inclusión aunque no se lo pida; hydrate, en cambio, lo descarta si no figura
// explícito, así que se agrega para que el documento conserve su _id.
const projectionObject = (projection) => Object.fromEntries([
  ...projection.include.map((path) => [path, 1]),
  ...(projection.include.length > 0 && !projection.idExcluded ? [["_id", 1]] : []),
  ...projection.exclude.map((path) => [path, 0]),
  ...(projection.idExcluded ? [["_id", 0]] : []),
]);

// Query encadenable y thenable. `data` es la lista de filas (o el documento
// para findOne) o una función que las devuelve; `record` es donde se anota
// lo que pidió el handler.
const createQuery = (data, record, { single = false, model = null, applyFilter = true } = {}) => {
  const materialize = () => {
    const resolved = typeof data === "function" ? data(record.filter, record) : data;
    // findOne/findById aceptan un documento suelto o una lista (se filtra y se
    // devuelve el primero que coincida).
    let rows = Array.isArray(resolved) || !single
      ? [...(resolved ?? [])]
      : (resolved === null || resolved === undefined ? [] : [resolved]);

    if (applyFilter) rows = rows.filter((row) => matchesFilter(row, record.filter));
    if (record.sort) rows.sort(compareBy(record.sort));
    if (record.limit !== undefined) rows = rows.slice(0, record.limit);
    if (single) rows = rows.slice(0, 1);

    const projection = parseProjection(record.selects);
    record.projection = projection;
    const hasProjection = projection.include.length > 0
      || projection.exclude.length > 0 || projection.idExcluded;

    rows = rows.map((row) => {
      if (record.lean) return applyProjection(toSource(row), projection);
      // Sin lean: un documento hidratado, con solo los campos seleccionados.
      // Sin modelo (o sin proyección sobre un documento ya hidratado) se
      // devuelve tal cual.
      if (!model) return hasProjection ? applyProjection(toSource(row), projection) : row;
      if (!hasProjection && typeof row?.toObject === "function") return row;
      const source = applyProjection(toSource(row), projection);
      return model.hydrate(source, hasProjection ? projectionObject(projection) : undefined);
    });

    return single ? (rows[0] ?? null) : rows;
  };

  const query = {
    record,
    select(fields) {
      record.selects.push(fields);
      record.select = fields;
      return query;
    },
    sort(spec) {
      record.sort = spec;
      return query;
    },
    lean() {
      record.lean = true;
      return query;
    },
    batchSize(size) {
      record.batchSize = size;
      return query;
    },
    limit(size) {
      record.limit = size;
      return query;
    },
    exec() {
      return Promise.resolve().then(materialize);
    },
    then(onFulfilled, onRejected) {
      return query.exec().then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return query.exec().catch(onRejected);
    },
  };
  return query;
};

const newRecord = (filter) => ({
  filter,
  selects: [],
  select: undefined,
  sort: undefined,
  lean: false,
  batchSize: undefined,
  limit: undefined,
  projection: undefined,
});

// Reemplaza Model[method] (con t.mock.method: se restaura solo al terminar el
// test) y devuelve la lista de llamadas registradas, una por invocación.
// Opciones: `hydrate: false` devuelve objetos planos en vez de documentos en
// las queries sin lean(); `applyFilter: false` devuelve las filas sin filtrar
// (cuando `rows` ya es una función que filtra por su cuenta, o cuando el
// test no quiere que el filtro decida).
const mockQuery = (t, Model, method, rows, { hydrate = true, applyFilter = true } = {}) => {
  const calls = [];
  const single = SINGLE_METHODS.has(method);
  t.mock.method(Model, method, (filterOrId) => {
    const filter = method === "findById" ? { _id: filterOrId } : filterOrId;
    const record = newRecord(filter);
    calls.push(record);
    return createQuery(rows, record, {
      single,
      model: hydrate ? Model : null,
      applyFilter: applyFilter && typeof rows !== "function",
    });
  });
  return calls;
};

module.exports = { createQuery, mockQuery, parseProjection, applyProjection };
