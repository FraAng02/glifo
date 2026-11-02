// Genera le icone dell'app (PWA, iOS, Android, desktop) disegnandole con MuPDF.
import * as mupdf from "mupdf";
import fs from "fs";

const FONT = ["/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf", "/System/Library/Fonts/NewYorkItalic.ttf"].find(fs.existsSync);
const font = FONT ? new mupdf.Font("G", fs.readFileSync(FONT)) : new mupdf.Font("Times-BoldItalic");
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

function squircle(path, x, y, s, r) {
  const k = 0.5523 * r;
  path.moveTo(x + r, y);
  path.lineTo(x + s - r, y); path.curveTo(x + s - r + k, y, x + s, y + r - k, x + s, y + r);
  path.lineTo(x + s, y + s - r); path.curveTo(x + s, y + s - r + k, x + s - r + k, y + s, x + s - r, y + s);
  path.lineTo(x + r, y + s); path.curveTo(x + r - k, y + s, x, y + s - r + k, x, y + s - r);
  path.lineTo(x, y + r); path.curveTo(x, y + r - k, x + r - k, y, x + r, y);
  path.closePath();
}

// inset: margine (frazione) per le icone macOS; full: sfondo a tutto quadrato (iOS/Android)
function icon(size, { inset = 0, full = false, maskable = false, bg = true, scale = 1, w = size, h = size } = {}) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], true);
  pix.clear(0);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const cs = mupdf.ColorSpace.DeviceRGB;
  const o = size * inset, s = size - 2 * o;
  if (bg) {
    const back = new mupdf.Path();
    if (full) back.rect(0, 0, w, h); else squircle(back, o, o, s, s * 0.225);
    dev.fillPath(back, false, mupdf.Matrix.identity, cs, rgb("#f6f1e7"), 1);
  }
  // contenuto ridotto per le icone "maskable" (zona sicura 80%)
  const c = (maskable ? 0.78 : 1) * scale;
  const cx = w / 2, cy = h / 2;
  const fs_ = s * 0.78 * c;
  const text = new mupdf.Text();
  const gid = font.encodeCharacter("g".codePointAt(0));
  const adv = font.advanceGlyph(gid) * fs_;
  const gx = cx - adv / 2 - s * 0.05 * c, gy = cy + s * 0.13 * c;
  text.showGlyph(font, [fs_, 0, 0, -fs_, gx, gy], gid, 103);
  dev.fillText(text, mupdf.Matrix.identity, cs, rgb("#1b1a17"), 1);
  // cursore vermiglio
  const bw = s * 0.055 * c, bh = s * 0.5 * c, bx = cx + s * 0.25 * c, by = cy - s * 0.31 * c;
  const caret = new mupdf.Path();
  caret.moveTo(bx, by + bw / 2); caret.lineTo(bx, by + bh - bw / 2);
  caret.curveTo(bx, by + bh, bx + bw, by + bh, bx + bw, by + bh - bw / 2);
  caret.lineTo(bx + bw, by + bw / 2); caret.curveTo(bx + bw, by, bx, by, bx, by + bw / 2);
  caret.closePath();
  dev.fillPath(caret, false, mupdf.Matrix.identity, cs, rgb("#e3472a"), 1);
  dev.close();
  return pix.asPNG();
}

const out = (p, png) => { fs.writeFileSync(p, png); console.log(p); };
out("public/icons/icon-192.png", icon(192, { full: true }));
out("public/icons/icon-512.png", icon(512, { full: true }));
out("public/icons/maskable-512.png", icon(512, { full: true, maskable: true }));
out("public/icons/apple-touch-icon.png", icon(180, { full: true }));
out("build/icon.png", icon(1024, { inset: 0.1 }));         // macOS / Windows
out("build/icon-full.png", icon(1024, { full: true }));     // iOS / Android

// ---------- progetti nativi (se presenti) ----------
const pngSize = (file) => { const im = new mupdf.Image(fs.readFileSync(file)); return [im.getWidth(), im.getHeight()]; };

if (fs.existsSync("ios/App/App/Assets.xcassets")) {
  out("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", icon(1024, { full: true }));
  const dir = "ios/App/App/Assets.xcassets/Splash.imageset";
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".png")) : []) {
    const [w, h] = pngSize(`${dir}/${f}`);
    out(`${dir}/${f}`, icon(Math.min(w, h) * 0.22, { full: true, w, h }));
  }
}

const RES = "android/app/src/main/res";
if (fs.existsSync(RES)) {
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    out(`${RES}/mipmap-${d}/ic_launcher.png`, icon(48 * k, { full: true }));
    out(`${RES}/mipmap-${d}/ic_launcher_round.png`, icon(48 * k, { full: true }));
    out(`${RES}/mipmap-${d}/ic_launcher_foreground.png`, icon(108 * k, { full: true, bg: false, scale: 0.62 }));
  }
  fs.writeFileSync(`${RES}/values/ic_launcher_background.xml`,
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#F6F1E7</color>\n</resources>\n');
  for (const d of fs.readdirSync(RES).filter((d) => d.startsWith("drawable"))) {
    const f = `${RES}/${d}/splash.png`;
    if (!fs.existsSync(f)) continue;
    const [w, h] = pngSize(f);
    out(f, icon(Math.min(w, h) * 0.3, { full: true, w, h }));
  }
}
