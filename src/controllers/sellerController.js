import Seller from "../models/Seller.js";


// Obtener todos los sellers
export const getSellers = async (req, res) => {
  try {
    const sellers = await Seller.find().sort({ createdAt: -1 });

    res.status(200).json(sellers);
  } catch (error) {
    console.error("Error al obtener sellers:", error);

    res.status(500).json({
      message: "Error al obtener los vendedores",
      error: error.message,
    });
  }
};

// Obtener seller por ID
export const getSellerById = async (req, res) => {
  try {
    const seller = await Seller.findById(req.params.id);

    if (!seller) {
      return res.status(404).json({
        message: "Vendedor no encontrado",
      });
    }

    res.status(200).json(seller);
  } catch (error) {
    console.error("Error al obtener seller:", error);

    res.status(500).json({
      message: "Error al obtener el vendedor",
      error: error.message,
    });
  }
};

// Crear seller
export const createSeller = async (req, res) => {
  try {
    const { name, dni } = req.body;

    // Validar datos obligatorios
    if (!name || !dni) {
      return res.status(400).json({
        message: "El nombre y el DNI son obligatorios",
      });
    }

    // Verificar si ya existe un seller con ese nombre
    const existingName = await Seller.findOne({ name });

    if (existingName) {
      return res.status(409).json({
        message: "Ya existe un vendedor con ese nombre",
      });
    }

    // Verificar si ya existe un seller con ese DNI
    const existingDni = await Seller.findOne({ dni });

    if (existingDni) {
      return res.status(409).json({
        message: "Ya existe un vendedor con ese DNI",
      });
    }

    // Generar código único
    let code;
    let existingCode;

    do {
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const numbers = "0123456789";

      let randomLetters = "";
      let randomNumbers = "";

      for (let i = 0; i < 3; i++) {
        randomLetters += letters.charAt(
          Math.floor(Math.random() * letters.length)
        );
      }

      for (let i = 0; i < 3; i++) {
        randomNumbers += numbers.charAt(
          Math.floor(Math.random() * numbers.length)
        );
      }

      code = `${randomLetters}-${randomNumbers}`;

      existingCode = await Seller.findOne({ code });
    } while (existingCode);

    // Crear seller
    const seller = await Seller.create({
      name,
      dni,
      code,
    });

    res.status(201).json(seller);
  } catch (error) {
    console.error("Error al crear seller:", error);

    // Manejar duplicados de MongoDB
    if (error.code === 11000) {
      return res.status(409).json({
        message: "El vendedor ya existe",
        error: error.keyValue,
      });
    }

    res.status(500).json({
      message: "Error al crear el vendedor",
      error: error.message,
    });
  }
};

// Modificar seller
export const updateSeller = async (req, res) => {
  try {
    const { name, dni } = req.body;

    const seller = await Seller.findById(req.params.id);

    if (!seller) {
      return res.status(404).json({
        message: "Vendedor no encontrado",
      });
    }

    // Verificar nombre duplicado
    if (name && name !== seller.name) {
      const existingName = await Seller.findOne({
        name,
        _id: { $ne: seller._id },
      });

      if (existingName) {
        return res.status(409).json({
          message: "Ya existe un vendedor con ese nombre",
        });
      }

      seller.name = name;
    }

    // Verificar DNI duplicado
    if (dni && dni !== seller.dni) {
      const existingDni = await Seller.findOne({
        dni,
        _id: { $ne: seller._id },
      });

      if (existingDni) {
        return res.status(409).json({
          message: "Ya existe un vendedor con ese DNI",
        });
      }

      seller.dni = dni;
    }

    await seller.save();

    res.status(200).json(seller);
  } catch (error) {
    console.error("Error al modificar seller:", error);

    if (error.code === 11000) {
      return res.status(409).json({
        message: "El vendedor ya existe",
        error: error.keyValue,
      });
    }

    res.status(500).json({
      message: "Error al modificar el vendedor",
      error: error.message,
    });
  }
};

// Eliminar seller
export const deleteSeller = async (req, res) => {
  try {
    const seller = await Seller.findByIdAndDelete(req.params.id);

    if (!seller) {
      return res.status(404).json({
        message: "Vendedor no encontrado",
      });
    }

    res.status(200).json({
      message: "Vendedor eliminado correctamente",
      seller,
    });
  } catch (error) {
    console.error("Error al eliminar seller:", error);

    res.status(500).json({
      message: "Error al eliminar el vendedor",
      error: error.message,
    });
  }
};

