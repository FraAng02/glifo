// Libreria font: file aggiunti dall'utente (IndexedDB) + font installati nel sistema.
import { norm } from "./engine/norm.js";
import { readFontFile, extractFace, findFace } from "./engine/fontfile.js";
import { isElectron } from "./platform.js";

const STORE = "fonts";
let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("glifo", 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export const listFonts = async () => { try { return (await tx("readonly", (s) => s.getAll())) || []; } catch { return []; } };
export const removeFont = (id) => tx("readwrite", (s) => s.delete(id));

export async function addFontFiles(files) {
  let added = 0;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let faces;
    try { faces = readFontFile(bytes); } catch { continue; }
    for (const f of faces) {
      const record = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, label: f.label, keys: f.keys, bytes: extractFace(bytes, f.face) };
      await tx("readwrite", (s) => s.put(record));
      added++;
    }
  }
  return added;
}

// ---------- font di sistema (Local Font Access API, Chromium/Electron) ----------
const FLAG = "glifo.systemFonts";
const getFlag = () => { try { return localStorage.getItem(FLAG) === "1"; } catch { return false; } };
export const systemFonts = {
  supported: "queryLocalFonts" in window,
  get enabled() { return this.supported && (isElectron || getFlag()); },
  async enable() {
    await window.queryLocalFonts();
    try { localStorage.setItem(FLAG, "1"); } catch {}
  },
};

let localList = null;
async function localFonts() {
  localList ??= window.queryLocalFonts().catch(() => { localList = null; return []; });
  return localList;
}

const cache = new Map();
// Byte del font completo che corrisponde a `fontName`, oppure null.
export async function resolveFont(fontName) {
  const key = norm(fontName);
  if (cache.has(key)) return cache.get(key);
  let bytes = null;
  try {
    const hit = (await listFonts()).find((f) => f.keys.includes(key));
    if (hit) bytes = hit.bytes;
    else if (systemFonts.enabled) {
      const f = (await localFonts()).find((f) => norm(f.postscriptName) === key || norm(f.fullName) === key);
      if (f) {
        const all = new Uint8Array(await (await f.blob()).arrayBuffer());
        bytes = findFace(all, f.postscriptName) || all;
      }
    }
  } catch { bytes = null; }
  cache.set(key, bytes);
  return bytes;
}
export const forgetResolved = () => cache.clear();
