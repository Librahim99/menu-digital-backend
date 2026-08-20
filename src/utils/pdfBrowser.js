const puppeteer = require("puppeteer");

let browserPromise = null;

/**
 * Devuelve una instancia de Chrome headless reutilizada entre requests.
 * Lanzar un browser nuevo en cada PDF es, con diferencia, la parte más
 * lenta de todo el proceso (varios segundos) — acá lo hacemos una sola vez
 * y lo mantenemos vivo mientras corre el servidor.
 */
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
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
    browserPromise = puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    return browserPromise;
  }

  return browser;
}

module.exports = { getBrowser };
