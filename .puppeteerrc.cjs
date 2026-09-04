const { join } = require("path");

// Fuerza la caché de Chrome a una ruta relativa al proyecto (en vez del
// default ~/.cache/puppeteer). En Koyeb, npm install corre en un paso de
// build separado del contenedor de runtime; todo lo que queda DENTRO del
// proyecto (como node_modules) viaja con esa mudanza, pero la caché global
// del home del usuario no siempre lo hace — de ahí el "Could not find
// Chrome" al intentar lanzar el browser ya en runtime.
// https://pptr.dev/guides/configuration
module.exports = {
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};
