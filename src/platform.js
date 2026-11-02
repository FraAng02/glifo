// Salvataggio/condivisione del PDF, a seconda di dove gira l'app.
export const isElectron = !!window.glifo?.isElectron;
export const isNative = !!window.Capacitor?.isNativePlatform?.();
export const isTouch = matchMedia("(pointer: coarse)").matches;

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Restituisce true se il file è stato salvato/condiviso.
export async function saveFile(name, bytes) {
  if (isElectron) return !!(await window.glifo.saveFile(name, bytes));

  if (isNative) {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    const { Share } = await import("@capacitor/share");
    const { uri } = await Filesystem.writeFile({ path: name, data: toBase64(bytes), directory: Directory.Cache });
    await Share.share({ title: name, files: [uri] });
    return true;
  }

  const file = new File([bytes], name, { type: "application/pdf" });
  if (isTouch && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e.name === "AbortError") return false; }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
