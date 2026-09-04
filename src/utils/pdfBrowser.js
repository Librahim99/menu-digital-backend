// En producción (Koyeb) el Chrome "for Testing" que descarga el paquete
// `puppeteer` completo no arranca: el contenedor de runtime no tiene las
// librerías de sistema que necesita (libatk, etc. — imagen mínima, sin
// Dockerfile propio para instalarlas con apt). `@sparticuz/chromium` trae un
// binario pensado para entornos Linux mínimos que no dependen de esas
// librerías, así que en producción se lanza con `puppeteer-core` + ese
// binario. En desarrollo (Windows/Mac) seguimos usando el Chrome que
// descarga el paquete `puppeteer` completo, porque el binario de
// `@sparticuz/chromium` es Linux-only.
const isProd = process.env.NODE_ENV === "production";
const puppeteer = isProd ? require("puppeteer-core") : require("puppeteer");

async function launchBrowser() {
  if (isProd) {
    // Import ESM con interop CJS: el objeto real queda en `.default`.
    const chromium = require("@sparticuz/chromium").default;
    return puppeteer.launch({
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
      executablePath: await chromium.executablePath(),
      headless: "shell",
    });
  }
  return puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

let browserPromise = null;

/**
 * Devuelve una instancia de Chrome headless reutilizada entre requests.
 * Lanzar un browser nuevo en cada PDF es, con diferencia, la parte más
 * lenta de todo el proceso (varios segundos) — acá lo hacemos una sola vez
 * y lo mantenemos vivo mientras corre el servidor.
 */
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launchBrowser();
  }

  let browser;
  try {
    browser = await browserPromise;
  } catch (err) {
    // Si el lanzamiento falló, no dejamos la promesa rota cacheada para
    // siempre — la próxima llamada vuelve a intentar desde cero.
    browserPromise = null;
    throw err;
  }

  // Si el browser se cayó (crash, out-of-memory, lo mató el sistema), lo
  // relanzamos en vez de seguir devolviendo un browser muerto hasta que
  // alguien reinicie el server a mano.
  if (!browser.connected) {
    browserPromise = launchBrowser();
    return browserPromise;
  }

  return browser;
}

module.exports = { getBrowser };
