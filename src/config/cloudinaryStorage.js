// ──────────────────────────────────────────────
// Storage engine de Multer para subir directo a Cloudinary, sin pasar por
// disco. Reemplaza a "multer-storage-cloudinary": ese paquete nunca
// actualizó su dependencia interna a cloudinary@2.x (sigue pidiendo
// ^1.21.0 en su propio package.json), así que aunque subamos el cloudinary
// de este proyecto, esa librería seguía instalando por debajo su propia
// copia vieja y vulnerable (GHSA-g4mf-96x5-5m2c). Este archivo replica el
// mismo comportamiento (mismos campos en req.file) hablando directo con el
// SDK de cloudinary@2.x, sin ese intermediario.
// ──────────────────────────────────────────────
class CloudinaryStorage {
  // params: objeto plano con las opciones de upload de Cloudinary
  // (folder, allowed_formats, transformation, etc. — mismo formato que
  // ya usábamos con multer-storage-cloudinary).
  constructor({ cloudinary, params = {} }) {
    if (!cloudinary) throw new Error("`cloudinary` es requerido");
    this.cloudinary = cloudinary;
    this.params = params;
  }

  // Multer llama a esto por cada archivo subido. Streamea el archivo
  // directo al upload_stream de Cloudinary, sin guardarlo en disco.
  _handleFile(req, file, callback) {
    const uploadStream = this.cloudinary.uploader.upload_stream(
      this.params,
      (err, result) => {
        if (err) return callback(err);
        // Mismos nombres de campo que multer-storage-cloudinary: los
        // controllers ya leen req.file.path esperando la URL pública.
        callback(null, {
          path: result.secure_url,
          size: result.bytes,
          filename: result.public_id,
        });
      }
    );
    file.stream.pipe(uploadStream);
  }

  // Multer llama a esto si necesita revertir una subida (ej: otro archivo
  // del mismo request falló). No la usa ningún controller directamente.
  _removeFile(req, file, callback) {
    this.cloudinary.uploader.destroy(file.filename, { invalidate: true }, callback);
  }
}

module.exports = { CloudinaryStorage };
