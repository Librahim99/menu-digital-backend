/**
 * Genera el HTML (con estilos embebidos) que Puppeteer convierte en el PDF
 * del menú. Recibe el mismo `menuArmado` que ya arma fetchUserWithMenu /
 * fetchOwnMenu: { secciones: [{...menu, categorias:[{...menu, items:[]}]}],
 * sinSeccion: [{...menu, items:[]}] }.
 */

function escapeHTML(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatPrice(value) {
  if (value === null || value === undefined) return "";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(value);
}

function renderPriceBlock(item) {
  // userController ya filtra offerPrice cuando la oferta todavía no comenzó
  // o ya finalizó; el template solo representa el estado público recibido.
  const offerActive = item.offerPrice != null;

  if (offerActive) {
    return `
      <div class="price-block">
        <span class="price-old">${formatPrice(item.price)}</span>
        <span class="price-offer">${formatPrice(item.offerPrice)}</span>
      </div>`;
  }

  if (item.price != null) {
    return `<div class="price-block"><span class="price">${formatPrice(item.price)}</span></div>`;
  }

  return "";
}

function renderOptions(options) {
  if (!options || Object.keys(options).length === 0) return "";
  const rows = Object.entries(options)
    .map(
      ([name, price]) =>
        `<li>
          <span class="opt-name">${escapeHTML(name)}</span>
          <span class="opt-dots"></span>
          <span class="opt-price">${formatPrice(price)}</span>
        </li>`
    )
    .join("");
  return `<ul class="item-options">${rows}</ul>`;
}

function renderItem(item) {
  return `
    <div class="item ${item.recommended ? "recommended" : ""}">
      ${item.image ? `<img class="item-img" src="${item.image}" alt="" />` : ""}
      <div class="item-body">
        <div class="item-top">
          <div class="item-name-wrap">
            <span class="item-title">${escapeHTML(item.title)}</span>
            ${item.recommended ? `<span class="reco-badge">★</span>` : ""}
          </div>
          ${renderPriceBlock(item)}
        </div>
        ${item.description ? `<p class="item-desc">${escapeHTML(item.description)}</p>` : ""}
        ${renderOptions(item.options)}
      </div>
    </div>`;
}

function renderCategoryBlock(categoria, { nested } = {}) {
  const items = (categoria.items || []).filter((it) => !it.hidden && it.available);
  if (items.length === 0) return "";

  const TitleTag = nested ? "h3" : "h2";

  return `
    <div class="category-block ${nested ? "nested" : ""}">
      <div class="category-header">
        ${categoria.image ? `<img class="category-img" src="${categoria.image}" alt="" />` : ""}
        <div class="category-header-text">
          <${TitleTag}>${escapeHTML(categoria.title)}</${TitleTag}>
          ${categoria.description ? `<p class="category-desc">${escapeHTML(categoria.description)}</p>` : ""}
        </div>
      </div>
      <div class="items-grid">
        ${items.map(renderItem).join("")}
      </div>
    </div>`;
}

function renderChapter(seccion) {
  const categoriesHTML = (seccion.categorias || [])
    .map((cat) => renderCategoryBlock(cat, { nested: true }))
    .filter(Boolean)
    .join("");

  if (!categoriesHTML) return "";

  return `
    <section class="chapter">
      <div class="chapter-header">
        ${seccion.image ? `<img class="chapter-img" src="${seccion.image}" alt="" />` : ""}
        <div class="chapter-header-text">
          <h1 class="chapter-title">${escapeHTML(seccion.title)}</h1>
          ${seccion.description ? `<p class="chapter-desc">${escapeHTML(seccion.description)}</p>` : ""}
        </div>
      </div>
      ${categoriesHTML}
    </section>`;
}

function buildMenuHTML({ businessName = "Menú", menuArmado }) {
  const secciones  = menuArmado?.secciones ?? [];
  const sinSeccion = menuArmado?.sinSeccion ?? [];

  const chaptersHTML = secciones.map(renderChapter).join("");
  const looseHTML = sinSeccion
    .map((cat) => renderCategoryBlock(cat, { nested: false }))
    .filter(Boolean)
    .join("");

  const body = chaptersHTML + looseHTML;
  const generatedAt = new Date().toLocaleDateString("es-AR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <style>
    @page {
      margin: 14mm 12mm 12mm 12mm;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      color: #1a1714;
      background: #ffffff;
      line-height: 1.35;
      font-size: 11px;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* ── Portada compacta (no ocupa página entera) ── */
    .cover {
      text-align: center;
      padding: 4mm 0 6mm 0;
      margin-bottom: 6mm;
      border-bottom: 1.5px solid #1a1714;
    }
    .cover-ornament {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .cover-ornament::before,
    .cover-ornament::after {
      content: "";
      height: 1px;
      width: 36px;
      background: #c4a574;
    }
    .cover-ornament span {
      color: #c4a574;
      font-size: 9px;
    }
    .cover h1 {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 22px;
      font-weight: 400;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: #1a1714;
    }
    .cover .subtitle {
      color: #8a7e72;
      font-size: 9.5px;
      margin-top: 4px;
      letter-spacing: 0.4px;
    }

    /* ── Sección ── */
    .chapter {
      margin-bottom: 7mm;
    }
    .chapter-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4mm;
      padding-bottom: 3px;
      border-bottom: 1.5px solid #1a1714;
    }
    .chapter-header-text { flex: 1; min-width: 0; }
    .chapter-title {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 15px;
      font-weight: 400;
      text-transform: uppercase;
      letter-spacing: 1.8px;
      color: #1a1714;
    }
    .chapter-desc {
      font-size: 9.5px;
      color: #7a7068;
      margin-top: 1px;
      font-style: italic;
      font-family: Georgia, serif;
    }
    .chapter-img {
      width: 28px;
      height: 28px;
      object-fit: cover;
      border-radius: 50%;
      border: 1px solid #e0d8cc;
      flex-shrink: 0;
    }

    /* ── Categoría ── */
    .category-block {
      margin-bottom: 5.5mm;
    }
    .category-block.nested {
      padding-left: 3mm;
      border-left: 1.5px solid #ebe4d8;
    }
    .category-header {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 3mm;
      padding-bottom: 2px;
      border-bottom: 1px solid #e8e0d4;
    }
    .category-header-text { flex: 1; min-width: 0; }
    .category-header h2,
    .category-header h3 {
      font-family: Georgia, "Times New Roman", serif;
      font-weight: 400;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      color: #1a1714;
    }
    .category-header h2 { font-size: 12.5px; }
    .category-header h3 { font-size: 11.5px; color: #3d3731; }
    .category-desc {
      font-size: 9px;
      color: #8a7e72;
      margin-top: 1px;
      font-style: italic;
    }
    .category-img {
      width: 22px;
      height: 22px;
      object-fit: cover;
      border-radius: 50%;
      border: 1px solid #e0d8cc;
      flex-shrink: 0;
    }

    /* ── Grilla: filas de altura uniforme por fila ── */
    .items-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      column-gap: 7mm;
      row-gap: 0;
      align-items: stretch;
    }

    /* Item: altura mínima fija + estructura estable */
    .item {
      display: flex;
      gap: 6px;
      align-items: flex-start;
      padding: 2.8mm 2mm;
      border-bottom: 1px solid #f0ebe3;
      min-height: 14mm;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .item.recommended {
      background: #faf7f0;
      border-radius: 3px;
      border-bottom-color: transparent;
      margin: 0.5mm 0;
      border: 1px solid #f0e6d4;
    }
    .item-img {
      width: 32px;
      height: 32px;
      object-fit: cover;
      border-radius: 4px;
      flex-shrink: 0;
      border: 1px solid #ebe3d6;
    }
    .item-body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
    }

    .item-top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 6px;
    }
    .item-name-wrap {
      display: flex;
      align-items: baseline;
      gap: 4px;
      min-width: 0;
      flex: 1;
    }
    .item-title {
      font-size: 11px;
      font-weight: 650;
      color: #1a1714;
      line-height: 1.25;
    }
    .reco-badge {
      color: #b8923e;
      font-size: 9px;
      flex-shrink: 0;
      line-height: 1;
    }
    .item-desc {
      font-size: 9px;
      color: #6e655c;
      margin-top: 1.5px;
      line-height: 1.3;
      font-style: italic;
      /* Máx 2 líneas → cards más parejas */
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .price-block {
      display: flex;
      align-items: baseline;
      gap: 4px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .price {
      font-size: 11px;
      font-weight: 700;
      color: #1a1714;
    }
    .price-old {
      font-size: 9px;
      color: #a89f94;
      text-decoration: line-through;
    }
    .price-offer {
      font-size: 11px;
      font-weight: 700;
      color: #a63d2f;
    }

    .item-options {
      list-style: none;
      margin-top: 2px;
      font-size: 8.5px;
      color: #5c554c;
    }
    .item-options li {
      display: flex;
      align-items: baseline;
      gap: 3px;
      padding: 0.5px 0;
    }
    .opt-name { flex-shrink: 0; }
    .opt-dots {
      flex: 1;
      border-bottom: 1px dotted #d4cbc0;
      min-width: 8px;
      height: 0.75em;
    }
    .opt-price {
      flex-shrink: 0;
      font-weight: 600;
      color: #3d3731;
    }
  </style>
</head>
<body>
  <div class="cover">
    <div class="cover-ornament"><span>◆</span></div>
    <h1>${escapeHTML(businessName)}</h1>
    <div class="subtitle">${generatedAt}</div>
  </div>
  ${body}
</body>
</html>`;
}

module.exports = { buildMenuHTML };
