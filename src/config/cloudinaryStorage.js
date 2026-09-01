// ──────────────────────────────────────────────
// Storage engine de Multer para subir directo a Cloudinary (cloudinary@2.x).
// Reemplaza a "multer-storage-cloudinary" (abandonado + dependencia vulnerable).
// ──────────────────────────────────────────────
class CloudinaryStorage {
  /**
   * @param {object} options
   * @param {object} options.cloudinary  - Instancia de cloudinary.v2 ya configurada
   * @param {object|function} [options.params={}] - Parámetros de upload (estáticos o función async)
   */
  constructor({ cloudinary, params = {} }) {
    if (!cloudinary) {
      throw new Error("`cloudinary` es requerido");
    }
    this.cloudinary = cloudinary;
    this.params = params;
  }

  async _resolveParams(req, file) {
    if (typeof this.params === "function") {
      return await this.params(req, file);
    }
    return this.params;
  }

  _handleFile(req, file, callback) {
    // Resolvemos params (pueden ser función)
    this._resolveParams(req, file)
      .then((params) => {
        // Forzamos resource_type image + los params del usuario
        const uploadOptions = {
          resource_type: "image",
          ...params,
        };

        const uploadStream = this.cloudinary.uploader.upload_stream(
          uploadOptions,
          (err, result) => {
            if (err) return callback(err);

            // Mismos campos que esperan los controllers (compatibilidad)
            callback(null, {
              path: result.secure_url,
              size: result.bytes,
              filename: result.public_id,   // public_id
              // extras útiles (opcional, no rompen nada)
              format: result.format,
              width: result.width,
              height: result.height,
            });
          }
        );

        // Propagar errores del stream de Multer
        file.stream.on("error", (err) => {
          uploadStream.destroy(err);
          callback(err);
        });

        file.stream.pipe(uploadStream);
      })
      .catch(callback);
  }

  _removeFile(req, file, callback) {
    // file.filename = public_id
    this.cloudinary.uploader.destroy(
      file.filename,
      { resource_type: "image", invalidate: true },
      callback
    );
  }
}

module.exports = { CloudinaryStorage };