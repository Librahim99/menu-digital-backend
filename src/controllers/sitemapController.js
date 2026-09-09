const User = require("../models/User");
const Menu = require("../models/Menu");
const Item = require("../models/Item");
const { getPlanForUser } = require("../services/planCatalog");

const SITE_URL = "https://www.menudigitalapp.com.ar";

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatDate(date) {
  if (!date) return null;

  const parsed = new Date(date);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function getLatestDate(...dates) {
  const validDates = dates
    .filter(Boolean)
    .map((date) => new Date(date))
    .filter((date) => !Number.isNaN(date.getTime()));

  if (validDates.length === 0) {
    return null;
  }

  return new Date(
    Math.max(...validDates.map((date) => date.getTime()))
  );
}

function buildUrlEntry(url, lastmod = null) {
  const lastmodXml = lastmod
    ? `\n    <lastmod>${escapeXml(formatDate(lastmod))}</lastmod>`
    : "";

  return `  <url>
    <loc>${escapeXml(url)}</loc>${lastmodXml}
  </url>`;
}

const getSitemap = async (req, res) => {
  try {
    /*
     * Solamente traemos usuarios que potencialmente pueden
     * generar una URL pública.
     */
    const users = await User.find({
      active: true,
      slug: {
        $exists: true,
        $ne: null,
        $ne: "",
      },
    })
      .select(
        "_id slug subscription subscriptionExpiresAt trialActive updatedAt"
      )
      .lean();

    const urls = [];

    // ─────────────────────────────────────────────
    // Páginas propias de MenuDigitalApp
    // ─────────────────────────────────────────────

    urls.push(
      buildUrlEntry(`${SITE_URL}/`),
      buildUrlEntry(`${SITE_URL}/contacto`),
      buildUrlEntry(`${SITE_URL}/terminos`),
      buildUrlEntry(`${SITE_URL}/privacidad`),
      buildUrlEntry(`${SITE_URL}/arrepentimiento`),
      buildUrlEntry(`${SITE_URL}/baja`)
    );

    // ─────────────────────────────────────────────
    // Negocios
    // ─────────────────────────────────────────────

    for (const user of users) {
      if (!user.slug) continue;

      /*
       * Usamos exactamente la misma fuente de verdad
       * que las rutas públicas del sistema.
       *
       * Esto contempla plan efectivo, vencimientos,
       * trials, etc.
       */
      const plan = await getPlanForUser(user);

      const baseUrl = `${SITE_URL}/${user.slug}`;

      // ─────────────────────────────────────────
      // Landing del negocio: /slug
      // Solamente si el plan la incluye.
      // ─────────────────────────────────────────

      if (plan.features?.landing_page === true) {
        urls.push(
          buildUrlEntry(
            baseUrl,
            user.updatedAt
          )
        );
      }

      // ─────────────────────────────────────────
      // Menú: /slug/menu
      //
      // Solo lo agregamos si existe contenido
      // público real.
      // ─────────────────────────────────────────

      const visibleMenus = await Menu.find({
        userID: user._id,
        hidden: false,
      })
        .select("_id updatedAt section")
        .lean();

      /*
       * Los productos pertenecen a categorías.
       * section === true representa contenedores,
       * no categorías con productos.
       */
      const categoryIds = visibleMenus
        .filter((menu) => menu.section === false)
        .map((menu) => menu._id);

      if (categoryIds.length === 0) {
        continue;
      }

      const visibleItems = await Item.find({
        menuID: { $in: categoryIds },
        hidden: false,
      })
        .select("updatedAt")
        .lean();

      /*
       * Evitamos enviar a Google menús vacíos.
       */
      if (visibleItems.length === 0) {
        continue;
      }

      const latestMenuUpdate = visibleMenus.reduce(
        (latest, menu) =>
          getLatestDate(latest, menu.updatedAt),
        null
      );

      const latestItemUpdate = visibleItems.reduce(
        (latest, item) =>
          getLatestDate(latest, item.updatedAt),
        null
      );

      const menuLastModified = getLatestDate(
        user.updatedAt,
        latestMenuUpdate,
        latestItemUpdate
      );

      urls.push(
        buildUrlEntry(
          `${baseUrl}/menu`,
          menuLastModified
        )
      );
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`;

    /*
     * Cacheamos durante 15 minutos.
     *
     * Google no necesita que MongoDB regenere el sitemap
     * en cada request.
     */
    res.set({
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control":
        "public, max-age=0, s-maxage=900, stale-while-revalidate=3600",
    });

    return res.status(200).send(xml);
  } catch (error) {
    console.error("Error generando sitemap:", error);

    return res
      .status(500)
      .type("text/plain")
      .send("Error generando sitemap");
  }
};

module.exports = {
  getSitemap,
};