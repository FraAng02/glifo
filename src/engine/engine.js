// Motore di modifica testo PDF basato su MuPDF (WebAssembly).
// Strategia font, in ordine di fedeltà:
//   1. "original": riusa la stessa risorsa font del PDF (codici dalla ToUnicode/Encoding)
//   2. "embedded": re-incorpora il font del PDF se contiene tutti i glifi
//   3. "library":  stesso font completo (installato, aggiunto dall'utente o scaricato)
//   4. "mixed":    lettere presenti dal font originale, le mancanti da un gemello open
//                  con le stesse misure (o da un font standard simile)
//   5. "twin" / "similar": tutto con il gemello open / con un font standard simile
import * as mupdf from "mupdf";
import { glyphNameToUnicode } from "./glyphs.js";
import { norm } from "./norm.js";
import { parseFontName } from "../webfonts.js";

export { norm };

const SIMILAR = {
  sans: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  serif: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
  mono: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};

const SERIF = /serif|times|roman|garamond|georgia|cambria|palatin|minion|caslon|baskerv|bodoni|didot|charter|playfair|merriweather|lora|tinos|gelasio|caladea|antiqua|bookman|century(?!gothic)/i;
// Famiglia del font standard di ripiego: dal nome, perché il flag "serif" dei PDF è spesso sbagliato
function similarName(span) {
  const family = parseFontName(span.fontName).words.join("");
  const kind = span.mono || /mono|courier|consol|code/i.test(family) ? "mono"
    : SERIF.test(family) && !/sans/i.test(family) ? "serif" : "sans";
  return SIMILAR[kind][(span.bold ? 1 : 0) + (span.italic ? 2 : 0)];
}

const decoders = {};
function baseEncoding(name) {
  const table = new Map();
  if (name === "StandardEncoding" || !name) {
    for (let c = 32; c < 127; c++) table.set(String.fromCharCode(c), c);
    table.set("’", 0x27).set("‘", 0x60);
    table.delete("'"); table.delete("`");
    return table;
  }
  const label = name === "MacRomanEncoding" ? "macintosh" : "windows-1252";
  const dec = (decoders[label] ??= new TextDecoder(label));
  for (let c = 32; c < 256; c++) {
    const ch = dec.decode(new Uint8Array([c]));
    if (ch !== "�" && !table.has(ch)) table.set(ch, c);
  }
  return table;
}

function hexToStr(hex) {
  let s = "";
  for (let i = 0; i + 3 < hex.length + 1; i += 4) s += String.fromCharCode(parseInt(hex.substr(i, 4).padEnd(4, "0"), 16));
  return s;
}

// Parser minimale di CMap ToUnicode -> Map(unicode -> code)
function parseToUnicode(text) {
  const map = new Map();
  const add = (code, uni) => { if ([...uni].length === 1 && !map.has(uni)) map.set(uni, code); };
  for (const sec of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of sec[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) add(parseInt(m[1], 16), hexToStr(m[2]));
  }
  for (const sec of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
    for (const m of sec[1].matchAll(re)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (hi - lo > 65535) continue;
      if (m[3] !== undefined) {
        const base = hexToStr(m[3]);
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) add(c, base.slice(0, -1) + String.fromCharCode(last + c - lo));
      } else {
        [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((d, i) => add(lo + i, hexToStr(d[1])));
      }
    }
  }
  return map;
}

const bytesOf = (buf) => (buf.asUint8Array ? buf.asUint8Array() : new Uint8Array(buf));
const latin1 = new TextDecoder("latin1");
const fmt = (n) => (Math.round(n * 1000) / 1000).toString();

export class Engine {
  constructor() {
    this.doc = null;
    this.libraryFonts = new Map(); // norm(nome) -> { font: mupdf.Font, exact, label }
    this.addedFonts = new Map();   // mupdf.Font -> PDFObject (font già aggiunti al documento)
    this.standardFonts = new Map(); // nome base14 -> mupdf.Font
    this.spanCache = new Map();
    this.undoStack = [];
    this.redoStack = [];
  }

  open(data) {
    this.doc = new mupdf.PDFDocument(data);
    this.spanCache.clear(); this.addedFonts.clear();
    this.undoStack = []; this.redoStack = [];
    const pages = [];
    for (let i = 0; i < this.doc.countPages(); i++) {
      const [x0, y0, x1, y1] = this.doc.loadPage(i).getBounds();
      pages.push({ width: x1 - x0, height: y1 - y0 });
    }
    let title = "";
    try { title = this.doc.getMetaData("info:Title") || ""; } catch {}
    return { pages, title };
  }

  registerFont(key, data, exact = true, label = "") {
    const cur = this.libraryFonts.get(key);
    if (cur && cur.size === data.length && cur.label === label) return true; // già registrato
    try { this.libraryFonts.set(key, { font: new mupdf.Font(key, data), exact, label, size: data.length }); return true; } catch { return false; }
  }

  render(pno, scale) {
    const page = this.doc.loadPage(pno);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    return pix.asPNG();
  }

  renderClip(page, rect, scale) {
    const r = rect.map((v) => v * scale);
    const box = [Math.floor(r[0]), Math.floor(r[1]), Math.ceil(r[2]), Math.ceil(r[3])];
    // Pixmap con origine in (0,0) e matrice traslata: più affidabile di un bbox con offset
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, box[2] - box[0], box[3] - box[1]], false);
    pix.clear(255);
    const m = [scale, 0, 0, scale, -box[0], -box[1]];
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    page.run(dev, m);
    dev.close();
    return { png: pix.asPNG(), rect: box.map((v) => v / scale) };
  }

  // ---------- estrazione testo ----------
  spans(pno) {
    if (this.spanCache.has(pno)) return this.spanCache.get(pno);
    const page = this.doc.loadPage(pno);
    const spans = [];
    let dir = [1, 0], cur = null;
    const flush = () => { if (cur && cur.text.trim()) spans.push(cur); cur = null; };
    page.toStructuredText("preserve-whitespace").walk({
      beginLine: (_b, _w, d) => { flush(); dir = d; },
      endLine: flush,
      onChar: (c, origin, font, size, quad, color) => {
        const name = font.getName();
        const col = color.join(",");
        if (!cur || cur.fontName !== name || Math.abs(cur.size - size) > 0.01 || cur._col !== col) {
          flush();
          cur = {
            text: "", origin, size, color, _col: col, dir, font, fontName: name,
            bbox: [quad[0], quad[1], quad[6], quad[7]],
            bold: font.isBold(), italic: font.isItalic(), serif: font.isSerif(), mono: font.isMono(),
          };
        }
        cur.text += c;
        const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
        cur.bbox = [Math.min(cur.bbox[0], ...xs), Math.min(cur.bbox[1], ...ys),
                    Math.max(cur.bbox[2], ...xs), Math.max(cur.bbox[3], ...ys)];
      },
    });
    this.spanCache.set(pno, spans);
    return spans;
  }

  publicSpans(pno) {
    return this.spans(pno).map((s, index) => ({
      index, text: s.text, bbox: s.bbox, size: s.size, fontName: s.fontName,
      bold: s.bold, italic: s.italic, color: s.color, dir: s.dir,
    }));
  }

  // ---------- risorse font della pagina ----------
  pageFonts(page) {
    const out = [];
    const fonts = page.getObject().getInheritable("Resources").get("Font");
    if (!fonts || fonts.isNull()) return out;
    fonts.forEach((ref, resName) => {
      try {
        const f = ref.resolve();
        const subtype = f.get("Subtype").asName();
        if (subtype === "Type3") return;
        const baseFont = f.get("BaseFont").isName() ? f.get("BaseFont").asName() : "";
        const twoByte = subtype === "Type0";
        let u2c = null;
        const tu = f.get("ToUnicode");
        if (tu && tu.isStream()) u2c = parseToUnicode(latin1.decode(bytesOf(tu.readStream())));
        const fromToUnicode = !!u2c && u2c.size > 0;
        if (!twoByte && (!u2c || u2c.size === 0)) {
          const enc = f.get("Encoding");
          if (enc.isName()) u2c = baseEncoding(enc.asName());
          else if (enc.isDictionary()) {
            const be = enc.get("BaseEncoding");
            u2c = baseEncoding(be.isName() ? be.asName() : "StandardEncoding");
            const diffs = enc.get("Differences");
            let code = 0;
            for (let i = 0; diffs.isArray() && i < diffs.length; i++) {
              const it = diffs.get(i);
              if (it.isNumber()) code = it.asNumber();
              else { const u = glyphNameToUnicode(it.asName()); if (u) u2c.set(u, code); code++; }
            }
          } else u2c = baseEncoding("StandardEncoding");
        }
        if (!u2c || u2c.size === 0) return;
        const desc = twoByte ? f.get("DescendantFonts").get(0).get("FontDescriptor") : f.get("FontDescriptor");
        const subset = /^[A-Z]{6}\+/.test(baseFont);
        out.push({ ref, baseFont, twoByte, u2c, subset, fromToUnicode, embedded: !!desc && !desc.isNull() });
      } catch { /* font non leggibile: ignorato */ }
    });
    return out;
  }

  // Sceglie il modo migliore per scrivere `text` con il font di `span`.
  pickFont(page, span, text) {
    const glyphs = [...text].filter((c) => c !== " ");
    const target = norm(span.fontName);
    const candidates = this.pageFonts(page)
      .map((f) => {
        const b = norm(f.baseFont);
        const score = b === target ? 3 : (b.startsWith(target) || target.startsWith(b)) && b ? 2 : 0;
        return { ...f, score };
      })
      .filter((f) => f.score > 0 && [...span.text].every((c) => c === " " || f.u2c.has(c)))
      .sort((a, b) => b.score - a.score);
    const res = candidates[0];
    let base = null; // faccia che copre solo una parte delle lettere
    if (res) {
      // Un font subset senza ToUnicode contiene con certezza solo i caratteri già usati
      let ok = (c) => res.u2c.has(c);
      if (res.subset && !res.fromToUnicode) {
        const seen = new Set(this.spans(page.pno).filter((s) => s.fontName === span.fontName).flatMap((s) => [...s.text]));
        ok = (c) => seen.has(c) && res.u2c.has(c);
      }
      base = { ref: res.ref, twoByte: res.twoByte, encode: (c) => (ok(c) ? res.u2c.get(c) : undefined) };
      if (glyphs.every(ok)) return { kind: "original", faces: [base] };
    }

    const has = (font) => (c) => font.encodeCharacter(c.codePointAt(0)) > 0;
    const usable = (font) => font && glyphs.every(has(font));
    const face = (font) => ({ font, twoByte: true, encode: (c) => { const g = font.encodeCharacter(c.codePointAt(0)); return g > 0 ? g : undefined; } });
    if (usable(span.font)) return { kind: "embedded", faces: [face(span.font)] };
    const lib = this.libraryFonts.get(target);
    if (lib?.exact && usable(lib.font)) return { kind: "library", faces: [face(lib.font)], label: lib.label };
    if (!base && span.font && glyphs.some(has(span.font))) base = face(span.font);

    // Lettere mancanti: gemello open con le stesse misure, altrimenti font standard
    let sub, label, twin = false;
    if (lib && usable(lib.font)) { sub = lib.font; label = lib.label; twin = true; }
    else {
      label = similarName(span);
      sub = this.standardFonts.get(label);
      if (!sub) { sub = new mupdf.Font(label); this.standardFonts.set(label, sub); }
    }
    if (base) {
      const missing = glyphs.filter((c) => base.encode(c) === undefined).length;
      return { kind: "mixed", faces: [base, face(sub)], label, twin, missing };
    }
    return { kind: twin ? "twin" : "similar", faces: [face(sub)], label, twin };
  }

  // Nome della risorsa che punta a `ref` nella pagina (la aggiunge se manca).
  resourceName(page, ref) {
    const res = page.getObject().getInheritable("Resources");
    if (page.getObject().get("Resources").isNull()) page.getObject().put("Resources", res);
    let fonts = res.get("Font");
    if (fonts.isNull()) { fonts = this.doc.newDictionary(); res.put("Font", fonts); }
    let name = null;
    fonts.forEach((v, k) => { if (v.isIndirect() && ref.isIndirect() && v.asIndirect() === ref.asIndirect()) name = String(k); });
    if (!name) {
      let i = 1;
      while (!fonts.get("GF" + i).isNull()) i++;
      name = "GF" + i;
      fonts.put(name, ref);
    }
    return name;
  }

  // Applica la modifica alla pagina (dentro un'operazione del journal).
  applyEdit(pno, index, text) {
    const page = this.doc.loadPage(pno);
    const span = this.spans(pno)[index];
    page.pno = pno;
    const choice = this.pickFont(page, span, text);
    for (const f of choice.faces) {
      if (f.ref) continue;
      f.ref = this.addedFonts.get(f.font);
      if (!f.ref) { f.ref = this.doc.addFont(f.font); this.addedFonts.set(f.font, f.ref); }
    }

    // Sequenze di caratteri consecutivi con la stessa faccia (la prima che ha il glifo)
    const runs = [];
    let cur = null;
    const flush = () => { if (cur?.hex) cur.parts.push(`<${cur.hex}>`), (cur.hex = ""); };
    for (const c of text) {
      let f = null, code;
      for (const cand of choice.faces) { code = cand.encode(c); if (code !== undefined) { f = cand; break; } }
      if (!f) {                            // spazio mancante nel font: avanzamento manuale
        if (!cur) runs.push((cur = { face: choice.faces[0], parts: [], hex: "" }));
        flush();
        cur.parts.push("-260");
        continue;
      }
      if (!cur || cur.face !== f) { flush(); runs.push((cur = { face: f, parts: [], hex: "" })); }
      cur.hex += code.toString(16).padStart(f.twoByte ? 4 : 2, "0");
    }
    flush();

    // Rimuove il testo originale (solo testo: immagini e grafica restano intatte)
    const [x0, y0, x1, y1] = span.bbox;
    const dy = (y1 - y0) * 0.2;
    const annot = page.createAnnotation("Redact");
    annot.setRect([x0 + 0.3, y0 + dy, x1 - 0.3, y1 - dy]);
    page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
    // La rimozione riscrive le risorse (e può rinominarle): il nome va cercato dopo
    for (const f of choice.faces) f.name = this.resourceName(page, f.ref);

    // Matrice di testo: spazio pagina (y verso il basso) -> spazio utente PDF
    const [dx, dyy] = span.dir;
    const [ox, oy] = span.origin;
    const tm = mupdf.Matrix.concat([dx, dyy, dyy, -dx, ox, oy], mupdf.Matrix.invert(page.getTransform()));
    const col = span.color;
    const colorOp = col.length === 1 ? `${fmt(col[0])} g` : col.length === 4 ? `${col.map(fmt).join(" ")} k` : `${col.map(fmt).join(" ")} rg`;
    const shows = runs.map((r) => `/${r.face.name} ${fmt(span.size)} Tf [${r.parts.join(" ")}] TJ`).join(" ");
    const ops = `q BT 0 Tc 0 Tw 100 Tz 0 Tr 0 Ts ${colorOp} ${tm.map(fmt).join(" ")} Tm ${shows} ET Q\n`;

    const pageObj = page.getObject();
    const old = pageObj.get("Contents");
    const contents = this.doc.newArray();
    contents.push(this.doc.addStream("q\n", {}));
    if (old.isArray()) old.forEach((s) => contents.push(s));
    else if (!old.isNull()) contents.push(old);
    contents.push(this.doc.addStream("\nQ\n" + ops, {}));
    pageObj.put("Contents", contents);

    return { kind: choice.kind, fontLabel: choice.label || span.fontName, twin: !!choice.twin, missing: choice.missing || 0 };
  }

  // Istantanea di ciò che una modifica tocca: contenuto e risorse della pagina.
  snapshot(pno) {
    const pageObj = this.doc.loadPage(pno).getObject();
    const old = pageObj.get("Contents");
    const streams = old.isArray() ? Array.from({ length: old.length }, (_, i) => old.get(i)) : old.isNull() ? [] : [old];
    const chunks = streams.map((st) => bytesOf(st.readStream()));
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length + 1, 0));
    let o = 0;
    for (const c of chunks) { bytes.set(c, o); o += c.length; bytes[o++] = 10; }
    const own = pageObj.get("Resources");
    return { pno, bytes, resources: own.isNull() ? null : this.copyDict(own, 2) };
  }

  copyDict(obj, depth) {
    const d = this.doc.newDictionary();
    obj.forEach((v, k) => d.put(k, depth > 1 && !v.isIndirect() && v.isDictionary() ? this.copyDict(v, depth - 1) : v));
    return d;
  }

  restore(snap) {
    const pageObj = this.doc.loadPage(snap.pno).getObject();
    pageObj.put("Contents", this.doc.addStream(snap.bytes, {}));
    if (snap.resources) pageObj.put("Resources", snap.resources);
    else pageObj.delete("Resources");
    this.spanCache.delete(snap.pno);
  }

  edit(pno, index, text) {
    const snap = this.snapshot(pno);
    const info = this.applyEdit(pno, index, text);
    this.undoStack.push(snap); this.redoStack = [];
    this.spanCache.delete(pno);
    return info;
  }

  // Anteprima esatta: applica, disegna solo la zona interessata, poi ripristina.
  preview(pno, index, text, scale) {
    const span = this.spans(pno)[index];
    const [, y0, , y1] = span.bbox;
    const pad = (y1 - y0) * 0.6;
    const width = this.doc.loadPage(pno).getBounds()[2];
    const rect = [Math.max(0, span.bbox[0] - pad), y0 - pad, width, y1 + pad];
    const snap = this.snapshot(pno);
    try {
      const info = this.applyEdit(pno, index, text);
      return { ...this.renderClip(this.doc.loadPage(pno), rect, scale), ...info };
    } finally {
      const spans = this.spanCache.get(pno);
      this.restore(snap);
      if (spans) this.spanCache.set(pno, spans); // il testo è tornato identico
    }
  }

  undo() {
    const snap = this.undoStack.pop();
    if (!snap) return null;
    this.redoStack.push(this.snapshot(snap.pno));
    this.restore(snap);
    return snap.pno;
  }

  redo() {
    const snap = this.redoStack.pop();
    if (!snap) return null;
    this.undoStack.push(this.snapshot(snap.pno));
    this.restore(snap);
    return snap.pno;
  }

  save() {
    return this.doc.saveToBuffer("garbage=compact,compress=yes").asUint8Array();
  }
}
