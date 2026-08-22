const User = require("../models/User");

// Normaliza un nombre a un slug URL-friendly.
// "Café Roma" -> "cafe-roma"
const generateSlug = (name) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

const generateUniqueSlug = async (name, excludeUserID = null) => {
  const base = generateSlug(name);
  if (!base) return undefined;

  let candidate = base;
  let suffix = 2;
  while (await User.exists({
    slug: candidate,
    ...(excludeUserID && { _id: { $ne: excludeUserID } }),
  })) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
};

const isDuplicateSlugError = (error) =>
  error?.code === 11000 &&
  Boolean(error?.keyPattern?.slug || error?.keyValue?.slug);

const createUserWithUniqueSlug = async (data) => {
  let lastError;

  // El query previo da un slug legible; el índice unique sigue siendo la
  // barrera real si dos altas con el mismo nombre corren al mismo tiempo.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = data.contactInfo?.businessName
      ? await generateUniqueSlug(data.contactInfo.businessName)
      : undefined;
    try {
      return await User.create({ ...data, slug });
    } catch (error) {
      if (!isDuplicateSlugError(error)) throw error;
      lastError = error;
    }
  }

  throw lastError;
};

const updateUserWithUniqueSlug = async (userID, updates) => {
  let lastError;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = await generateUniqueSlug(
      updates.contactInfo.businessName,
      userID
    );
    const updatesWithSlug = slug ? { ...updates, slug } : updates;

    try {
      return await User.findByIdAndUpdate(
        userID,
        { $set: updatesWithSlug },
        { new: true, runValidators: true }
      );
    } catch (error) {
      if (!isDuplicateSlugError(error)) throw error;
      lastError = error;
    }
  }

  throw lastError;
};

module.exports = {
  createUserWithUniqueSlug,
  generateSlug,
  generateUniqueSlug,
  updateUserWithUniqueSlug,
};
