// La única fuente legítima de `image` (Item/Menu) es Cloudinary — tanto el
// upload directo desde el navegador como el endpoint /upload-image del
// backend suben ahí y guardan la `secure_url` que Cloudinary devuelve.
// Restringir el campo a ese host cierra el SSRF de que una URL arbitraria
// (red interna, metadata de nube, etc.) termine siendo pedida por el Chrome
// headless que arma el PDF del menú — ver src/utils/menuPdfTemplate.js.
const isValidImageUrl = (value) => {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string") return false;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) return false;

  return value.startsWith(`https://res.cloudinary.com/${cloudName}/`);
};

module.exports = { isValidImageUrl };
