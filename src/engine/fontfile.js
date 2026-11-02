// Lettura minimale di file font (TTF/OTF/TTC): nomi e estrazione da collezioni.
import { norm } from "./norm.js";

const tag = (v, o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

function tables(view, offset) {
  const n = view.getUint16(offset + 4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = offset + 12 + i * 16;
    out.push({ tag: tag(view, r), checksum: view.getUint32(r + 4), offset: view.getUint32(r + 8), length: view.getUint32(r + 12) });
  }
  return out;
}

function names(view, offset) {
  const name = tables(view, offset).find((t) => t.tag === "name");
  const out = new Set();
  out.label = "";
  if (!name) return out;
  const base = name.offset, count = view.getUint16(base + 2), strings = base + view.getUint16(base + 4);
  for (let i = 0; i < count; i++) {
    const r = base + 6 + i * 12;
    const platform = view.getUint16(r), id = view.getUint16(r + 6);
    const len = view.getUint16(r + 8), off = strings + view.getUint16(r + 10);
    if (id !== 4 && id !== 6) continue; // nome completo e PostScript
    let s = "";
    if (platform === 3 || platform === 0) for (let j = 0; j < len; j += 2) s += String.fromCharCode(view.getUint16(off + j));
    else for (let j = 0; j < len; j++) s += String.fromCharCode(view.getUint8(off + j));
    if (s) out.add(s);
    const lang = view.getUint16(r + 4);
    const english = (platform === 1 && lang === 0) || (platform === 3 && lang === 0x409);
    if (s && english && (id === 4 || (id === 6 && !out.label))) out.label = s;
  }
  return out;
}

function faces(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(view, 0) !== "ttcf") return [{ view, offset: 0 }];
  const n = view.getUint32(8);
  return Array.from({ length: n }, (_, i) => ({ view, offset: view.getUint32(12 + i * 4) }));
}

// Ricostruisce un font singolo (sfnt) a partire da un elemento di una collezione.
function standalone(bytes, { view, offset }) {
  if (offset === 0 && tag(view, 0) !== "ttcf") return bytes;
  const ts = tables(view, offset);
  let size = 12 + ts.length * 16;
  for (const t of ts) size += (t.length + 3) & ~3;
  const out = new Uint8Array(size), ov = new DataView(out.buffer);
  out.set(bytes.subarray(offset, offset + 12));
  let pos = 12 + ts.length * 16;
  ts.forEach((t, i) => {
    const r = 12 + i * 16;
    for (let k = 0; k < 4; k++) ov.setUint8(r + k, t.tag.charCodeAt(k));
    ov.setUint32(r + 4, t.checksum); ov.setUint32(r + 8, pos); ov.setUint32(r + 12, t.length);
    out.set(bytes.subarray(t.offset, t.offset + t.length), pos);
    pos += (t.length + 3) & ~3;
  });
  return out;
}

// [{ keys: [nomi normalizzati], label, bytes }] per ogni font contenuto nel file
export function readFontFile(bytes) {
  return faces(bytes).map((face) => {
    const n = names(face.view, face.offset);
    return { keys: [...new Set([...n].map(norm))], label: n.label || [...n][0] || "Font", face };
  });
}

export function extractFace(bytes, face) {
  return standalone(bytes, face);
}

// Il font nel file il cui nome corrisponde a `name` (normalizzato), come sfnt singolo
export function findFace(bytes, name) {
  const key = norm(name);
  for (const f of readFontFile(bytes)) if (f.keys.includes(key)) return standalone(bytes, f.face);
  return null;
}
