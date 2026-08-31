const { handleError } = require("../utils/handleError");
const ExcelJS = require("exceljs");
const Menu = require("../models/Menu");
const Item = require("../models/Item");
const { getRequestPlan } = require("../services/planCatalog");
const { normalizeOffer } = require("../utils/offers");

// ──────────────────────────────────────────────
// Helper: normaliza SI/NO a boolean
// ──────────────────────────────────────────────
const parseBool = (val) => {
  if (typeof val === "boolean") return val;
  if (typeof val === "string") return val.trim().toUpperCase() === "SI";
  return false;
};

const countNewItemCodes = (itemsRows, existingItems) => {
  const existingCodes = new Set(existingItems.map((item) => item.code));
  return new Set(
    itemsRows
      .map((row) => row["codigo"]?.toString().trim())
      .filter((code) => code && !existingCodes.has(code))
  ).size;
};

const exceedsItemLimit = (itemLimit, existingItems, itemsRows) => {
  if (itemLimit === null) return null;
  const newCount = countNewItemCodes(itemsRows, existingItems);
  const requestedTotal = existingItems.length + newCount;
  return newCount > 0 && requestedTotal > itemLimit ? { itemLimit, requestedTotal } : null;
};

// ──────────────────────────────────────────────
// Helper: estilos para el Excel
// ──────────────────────────────────────────────
const styleHeader = (row) => {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FF1D4ED8" } },
    };
  });
  row.height = 22;
};

// ──────────────────────────────────────────────
// @desc    Generar y descargar la plantilla Excel con los datos actuales
// @route   GET /api/massive/template
// @access  Private
// ──────────────────────────────────────────────
const getTemplate = async (req, res) => {
  try {
    const userID = req.user._id;

    const [menus, items] = await Promise.all([
      Menu.find({ userID }),
      Item.find({ menuID: { $in: (await Menu.find({ userID })).map((m) => m._id) } }),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Menú Digital";

    // ── Hoja 1: Instrucciones ─────────────────────────────────────────────
    const instrSheet = workbook.addWorksheet("📋 Instrucciones");
    instrSheet.mergeCells("A1:D1");
    instrSheet.getCell("A1").value = "📋 ¿Cómo usar esta planilla?";
    instrSheet.getCell("A1").font = { bold: true, size: 14 };
    instrSheet.getCell("A1").alignment = { horizontal: "center" };

    const instrucciones = [
      [""],
      ["🟦 Hoja CATEGORÍAS"],
      ["  • Cada fila es una sección o categoría de tu menú."],
      ["  • Si el código ya existe → se actualiza. Si es nuevo → se crea."],
      ["  • ¿Es sección? → poné SI. Las secciones agrupan categorías (ej: Comidas, Bebidas)."],
      ["  • Código sección padre → dejalo vacío si la categoría no pertenece a ninguna sección."],
      ["  • Oculto SI/NO → SI = no se muestra a los clientes (no se borra)."],
      [""],
      ["🟩 Hoja PRODUCTOS"],
      ["  • Cada fila es un producto de tu menú."],
      ["  • Si el código ya existe → se actualiza. Si es nuevo → se crea."],
      ["  • Código categoría → tiene que coincidir con un código de la hoja Categorías."],
      ["  • Precio oferta → dejalo vacío si no hay oferta."],
      ["  • Inicio oferta / Fin oferta → fechas en formato DD/MM/AAAA (ej: 15/07/2025)."],
      ["  • Extra, Destacado, Oculto, Disponible → SI o NO."],
      [""],
      ["⚠️  No cambies los nombres de las columnas."],
      ["⚠️  No borres filas que no querés modificar, dejálas como están."],
      ["⚠️  Las imágenes se cargan desde la aplicación, no desde acá."],
    ];

    instrucciones.forEach((row) => {
      const r = instrSheet.addRow(row);
      r.getCell(1).alignment = { wrapText: true };
    });

    instrSheet.getColumn(1).width = 80;

    // ── Hoja 2: Categorías ────────────────────────────────────────────────
    const menuSheet = workbook.addWorksheet("🟦 Categorías");
    menuSheet.columns = [
      { header: "codigo",            key: "codigo",      width: 18 },
      { header: "titulo",            key: "titulo",      width: 28 },
      { header: "descripcion",       key: "descripcion", width: 38 },
      { header: "es_seccion",        key: "es_seccion",  width: 14 },
      { header: "codigo_seccion_padre", key: "codigo_seccion_padre", width: 22 },
      { header: "oculto",            key: "oculto",      width: 12 },
    ];
    styleHeader(menuSheet.getRow(1));

    // Mapa de ID → code para resolver sectionID
    const menuMap = {};
    menus.forEach((m) => { menuMap[m._id.toString()] = m.code; });

    menus.forEach((m) => {
      menuSheet.addRow({
        codigo:               m.code,
        titulo:               m.title,
        descripcion:          m.description || "",
        es_seccion:           m.section ? "SI" : "NO",
        codigo_seccion_padre: m.sectionID ? (menuMap[m.sectionID.toString()] || "") : "",
        oculto:               m.hidden ? "SI" : "NO",
      });
    });

    // ── Hoja 3: Productos ─────────────────────────────────────────────────
    const itemSheet = workbook.addWorksheet("🟩 Productos");
    itemSheet.columns = [
      { header: "codigo",           key: "codigo",           width: 18 },
      { header: "codigo_categoria", key: "codigo_categoria", width: 20 },
      { header: "titulo",           key: "titulo",           width: 30 },
      { header: "descripcion",      key: "descripcion",      width: 40 },
      { header: "precio",           key: "precio",           width: 12 },
      { header: "precio_oferta",    key: "precio_oferta",    width: 15 },
      { header: "inicio_oferta",    key: "inicio_oferta",    width: 16 },
      { header: "fin_oferta",       key: "fin_oferta",       width: 16 },
      { header: "extra",            key: "extra",            width: 10 },
      { header: "destacado",        key: "destacado",        width: 12 },
      { header: "oculto",           key: "oculto",           width: 10 },
      { header: "disponible",       key: "disponible",       width: 12 },
    ];
    styleHeader(itemSheet.getRow(1));

    items.forEach((item) => {
      itemSheet.addRow({
        codigo:           item.code,
        codigo_categoria: menuMap[item.menuID.toString()] || "",
        titulo:           item.title,
        descripcion:      item.description || "",
        precio:           item.price ?? "",
        precio_oferta:    item.offerPrice ?? "",
        inicio_oferta:    item.offerRange?.from ? new Date(item.offerRange.from).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }) : "",
        fin_oferta:       item.offerRange?.to   ? new Date(item.offerRange.to).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })   : "",
        extra:            item.isExtra    ? "SI" : "NO",
        destacado:        item.recommended ? "SI" : "NO",
        oculto:           item.hidden     ? "SI" : "NO",
        disponible:       item.available  ? "SI" : "NO",
      });
    });

    // ── Enviar archivo ────────────────────────────────────────────────────
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=menu-digital-plantilla.xlsx");

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// Helper: parsea las dos hojas del Excel subido
// Devuelve { menusRows, itemsRows }
// ──────────────────────────────────────────────
const parseExcel = async (buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const parseSheet = (sheet) => {
    const headers = [];
    const rows = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) {
        row.eachCell((cell) => headers.push(cell.value?.toString().trim()));
        return;
      }
      const obj = {};
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        obj[headers[colNumber - 1]] = cell.value ?? "";
      });
      // Ignorar filas completamente vacías
      if (Object.values(obj).some((v) => v !== "")) rows.push({ ...obj, _rowNumber: rowNumber });
    });
    return rows;
  };

  const menuSheet = workbook.getWorksheet("🟦 Categorías");
  const itemSheet = workbook.getWorksheet("🟩 Productos");

  if (!menuSheet || !itemSheet) throw new Error("El archivo no tiene las hojas correctas. Usá la plantilla original.");

  return {
    menusRows: parseSheet(menuSheet),
    itemsRows: parseSheet(itemSheet),
  };
};

// ──────────────────────────────────────────────
// Helper: parsea una fecha DD/MM/AAAA a Date o null
// ──────────────────────────────────────────────
const parseDate = (val, endOfDay = false) => {
  if (!val) return null;
  let d;
  let m;
  let y;
  // ExcelJS representa las celdas de fecha como medianoche UTC. Tomamos sus
  // componentes, pero aplicamos el día comercial completo en horario argentino.
  if (val instanceof Date) {
    d = String(val.getUTCDate());
    m = String(val.getUTCMonth() + 1);
    y = String(val.getUTCFullYear());
  } else {
    const str = val.toString().trim();
    if (!str) return null;
    [d, m, y] = str.split("/");
  }
  if (!d || !m || !y) return null;
  const time = endOfDay ? "23:59:59.999" : "00:00:00.000";
  const date = new Date(`${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${time}-03:00`);
  return isNaN(date) ? null : date;
};

// ──────────────────────────────────────────────
// @desc    Preview: procesa el Excel y devuelve el resumen de cambios sin guardar nada.
//          El front muestra este resumen al usuario antes de confirmar.
// @route   POST /api/massive/preview
// @access  Private
// ──────────────────────────────────────────────
const previewMassive = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No se recibió ningún archivo" });

    const userID = req.user._id;
    const { menusRows, itemsRows } = await parseExcel(req.file.buffer);

    // Traemos todos los menus e items actuales del user para comparar
    const existingMenus = await Menu.find({ userID });
    const menusByCode = {};
    existingMenus.forEach((m) => { menusByCode[m.code] = m; });

    const existingItems = await Item.find({
      menuID: { $in: existingMenus.map((m) => m._id) },
    });
    const limitExceeded = exceedsItemLimit((await getRequestPlan(req)).features.item_limit, existingItems, itemsRows);
    if (limitExceeded) {
      return res.status(403).json({
        message: `La importación dejaría ${limitExceeded.requestedTotal} productos y tu plan permite hasta ${limitExceeded.itemLimit}.`,
      });
    }
    const itemsByCode = {};
    existingItems.forEach((i) => { itemsByCode[i.code] = i; });

    const resumen = {
      categorias: { crear: [], actualizar: [], errores: [] },
      productos:  { crear: [], actualizar: [], errores: [] },
    };

    // ── Procesar categorías ───────────────────────────────────────────────
    for (const row of menusRows) {
      const codigo = row["codigo"]?.toString().trim();
      if (!codigo) {
        resumen.categorias.errores.push({ fila: row._rowNumber, razon: "Falta el código" });
        continue;
      }

      const existe = !!menusByCode[codigo];

      if (!existe) {
        resumen.categorias.crear.push({ fila: row._rowNumber, codigo, titulo: row["titulo"] });
      } else {
        // Detectar qué cambió
        const m = menusByCode[codigo];
        const cambios = [];
        if (row["titulo"] && row["titulo"] !== m.title) cambios.push("titulo");
        if (row["descripcion"] !== undefined && row["descripcion"] !== (m.description || "")) cambios.push("descripcion");
        if (row["es_seccion"] && parseBool(row["es_seccion"]) !== m.section) cambios.push("es_seccion");
        if (row["oculto"] && parseBool(row["oculto"]) !== m.hidden) cambios.push("oculto");
        if (cambios.length > 0)
          resumen.categorias.actualizar.push({ fila: row._rowNumber, codigo, cambios });
      }
    }

    // ── Procesar productos ────────────────────────────────────────────────
    // Importante: además de las categorías que ya existen en la base,
    // sumamos los códigos de categorías presentes en ESTE Excel (incluso si
    // son nuevas y todavía no se guardaron). Sin esto, un Excel que trae
    // categorías y productos nuevos a la vez marca error en todos los
    // productos, porque su categoría "todavía no existe" en la base aunque
    // sí va a crearse en el mismo import.
    const codigosCategoriasEnExcel = new Set(
      menusRows.map((r) => r["codigo"]?.toString().trim()).filter(Boolean)
    );

    for (const row of itemsRows) {
      const codigo = row["codigo"]?.toString().trim();
      if (!codigo) {
        resumen.productos.errores.push({ fila: row._rowNumber, razon: "Falta el código" });
        continue;
      }

      // Verifica que la categoría exista (ya en la base, o nueva en este mismo Excel)
      const codigoCat = row["codigo_categoria"]?.toString().trim();
      const categoriaValida = !codigoCat || menusByCode[codigoCat] || codigosCategoriasEnExcel.has(codigoCat);
      if (codigoCat && !categoriaValida) {
        resumen.productos.errores.push({
          fila: row._rowNumber,
          codigo,
          razon: `La categoría con código "${codigoCat}" no existe`,
        });
        continue;
      }

      const existe = !!itemsByCode[codigo];

      if (!existe) {
        resumen.productos.crear.push({ fila: row._rowNumber, codigo, titulo: row["titulo"] });
      } else {
        const item = itemsByCode[codigo];
        const cambios = [];
        if (row["titulo"] && row["titulo"] !== item.title) cambios.push("titulo");
        if (row["descripcion"] !== undefined && row["descripcion"] !== (item.description || "")) cambios.push("descripcion");
        if (row["precio"] !== "" && Number(row["precio"]) !== item.price) cambios.push("precio");
        if (row["precio_oferta"] !== "" && Number(row["precio_oferta"]) !== item.offerPrice) cambios.push("precio_oferta");
        if (row["oculto"] && parseBool(row["oculto"]) !== item.hidden) cambios.push("oculto");
        if (row["disponible"] && parseBool(row["disponible"]) !== item.available) cambios.push("disponible");
        if (codigoCat && menusByCode[codigoCat]?._id.toString() !== item.menuID.toString()) cambios.push("categoria");
        if (cambios.length > 0)
          resumen.productos.actualizar.push({ fila: row._rowNumber, codigo, cambios });
      }
    }

    res.json({
      resumen,
      mensaje: `Se crearán ${resumen.categorias.crear.length} categorías y ${resumen.productos.crear.length} productos. Se actualizarán ${resumen.categorias.actualizar.length} categorías y ${resumen.productos.actualizar.length} productos. Errores: ${resumen.categorias.errores.length + resumen.productos.errores.length}.`,
    });
  } catch (err) {
    handleError(res, err);
  }
};

// ──────────────────────────────────────────────
// @desc    Confirm: aplica efectivamente los cambios del Excel.
//          Procesa fila por fila e informa qué falló y qué no.
// @route   POST /api/massive/confirm
// @access  Private
// ──────────────────────────────────────────────
const confirmMassive = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No se recibió ningún archivo" });

    const userID = req.user._id;
    const { menusRows, itemsRows } = await parseExcel(req.file.buffer);

    const existingMenus = await Menu.find({ userID });
    const menusByCode = {};
    existingMenus.forEach((m) => { menusByCode[m.code] = m; });

    // Se valida antes de crear categorías para evitar una importación parcial
    // si el Excel supera el límite de productos del plan.
    const existingItems = await Item.find({ menuID: { $in: existingMenus.map((m) => m._id) } });
    const limitExceeded = exceedsItemLimit((await getRequestPlan(req)).features.item_limit, existingItems, itemsRows);
    if (limitExceeded) {
      return res.status(403).json({
        message: `La importación dejaría ${limitExceeded.requestedTotal} productos y tu plan permite hasta ${limitExceeded.itemLimit}.`,
      });
    }

    const resultado = {
      categorias: { creadas: [], actualizadas: [], errores: [] },
      productos:  { creados: [], actualizados: [], errores: [] },
    };

    // ── Procesar categorías primero (los items dependen de ellas) ─────────
    for (const row of menusRows) {
      const codigo = row["codigo"]?.toString().trim();
      if (!codigo) {
        resultado.categorias.errores.push({ fila: row._rowNumber, razon: "Falta el código" });
        continue;
      }

      try {
        const sectionCode = row["codigo_seccion_padre"]?.toString().trim();
        const sectionID   = sectionCode ? menusByCode[sectionCode]?._id ?? null : null;

        const data = {
          title:       row["titulo"]?.toString().trim() || undefined,
          description: row["descripcion"]?.toString().trim() || "",
          section:     parseBool(row["es_seccion"]),
          sectionID,
          hidden:      parseBool(row["oculto"]),
        };

        if (menusByCode[codigo]) {
          // UPDATE
          const updated = await Menu.findByIdAndUpdate(
            menusByCode[codigo]._id,
            { $set: data },
            { new: true }
          );
          menusByCode[codigo] = updated; // Actualizar el mapa en memoria
          resultado.categorias.actualizadas.push({ fila: row._rowNumber, codigo });
        } else {
          // CREATE
          const created = await Menu.create({ ...data, code: codigo, userID });
          menusByCode[codigo] = created;
          resultado.categorias.creadas.push({ fila: row._rowNumber, codigo });
        }
      } catch (err) {
        resultado.categorias.errores.push({ fila: row._rowNumber, codigo, razon: err.message });
      }
    }

    // ── Procesar productos ────────────────────────────────────────────────
    const itemsByCode = {};
    existingItems.forEach((i) => { itemsByCode[i.code] = i; });

    for (const row of itemsRows) {
      const codigo = row["codigo"]?.toString().trim();
      if (!codigo) {
        resultado.productos.errores.push({ fila: row._rowNumber, razon: "Falta el código" });
        continue;
      }

      try {
        const codigoCat = row["codigo_categoria"]?.toString().trim();
        const menuDoc   = codigoCat ? menusByCode[codigoCat] : null;

        if (codigoCat && !menuDoc) {
          resultado.productos.errores.push({
            fila: row._rowNumber, codigo,
            razon: `Categoría "${codigoCat}" no encontrada`,
          });
          continue;
        }

        const price = row["precio"] !== "" ? Number(row["precio"]) : null;
        const normalizedOffer = normalizeOffer({
          price,
          offerPrice: row["precio_oferta"] !== "" ? Number(row["precio_oferta"]) : null,
          offerRange: {
            from: parseDate(row["inicio_oferta"]),
            to: parseDate(row["fin_oferta"], true),
          },
        });
        if (normalizedOffer.error) throw new Error(normalizedOffer.error);

        const data = {
          title:       row["titulo"]?.toString().trim() || undefined,
          description: row["descripcion"]?.toString().trim() || "",
          price,
          offerPrice: normalizedOffer.offerPrice,
          offerRange: normalizedOffer.offerRange,
          isExtra:     parseBool(row["extra"]),
          recommended: parseBool(row["destacado"]),
          hidden:      parseBool(row["oculto"]),
          available:   parseBool(row["disponible"]),
          ...(menuDoc && { menuID: menuDoc._id }),
        };

        if (itemsByCode[codigo]) {
          await Item.findByIdAndUpdate(itemsByCode[codigo]._id, { $set: data });
          resultado.productos.actualizados.push({ fila: row._rowNumber, codigo });
        } else {
          if (!menuDoc) {
            resultado.productos.errores.push({
              fila: row._rowNumber, codigo,
              razon: "Se requiere codigo_categoria para crear un producto nuevo",
            });
            continue;
          }
          await Item.create({ ...data, code: codigo });
          resultado.productos.creados.push({ fila: row._rowNumber, codigo });
        }
      } catch (err) {
        resultado.productos.errores.push({ fila: row._rowNumber, codigo, razon: err.message });
      }
    }

    res.json({ resultado });
  } catch (err) {
    handleError(res, err);
  }
};

module.exports = { getTemplate, previewMassive, confirmMassive };
