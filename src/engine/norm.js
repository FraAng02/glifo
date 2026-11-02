// Normalizza un nome di font: senza prefisso subset, minuscolo, solo lettere e cifre.
export const norm = (name) =>
  String(name || "").replace(/^[A-Z]{6}\+/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
