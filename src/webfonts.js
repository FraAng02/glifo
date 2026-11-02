// Font da internet: cataloghi open (Google Fonts via Fontsource) per avere il font
// completo anche dove i font di sistema non sono leggibili (iPhone, Android, browser).
// Per i font commerciali più diffusi si usa il "gemello" open con le stesse misure.
import { norm } from "./engine/norm.js";

const API = "https://api.fontsource.org/v1/fonts/";

// Font commerciali -> equivalente open metricamente compatibile (o il più vicino)
const TWINS = {
  arial: "arimo", helvetica: "arimo", helveticaneue: "arimo", liberationsans: "arimo", nimbussans: "arimo",
  timesnewroman: "tinos", times: "tinos", timesroman: "tinos", liberationserif: "tinos", nimbusroman: "tinos",
  couriernew: "cousine", courier: "cousine", liberationmono: "cousine", nimbusmono: "cousine",
  calibri: "carlito", cambria: "caladea", georgia: "gelasio",
  garamond: "eb-garamond", adobegaramond: "eb-garamond", futura: "jost",
  segoeui: "open-sans", verdana: "dejavu-sans", tahoma: "dejavu-sans",
  sfpro: "inter", sfprotext: "inter", sfprodisplay: "inter", sfui: "inter", sfuitext: "inter", sfuidisplay: "inter",
  comicsansms: "comic-neue", centurygothic: "questrial",
};

const WEIGHTS = [
  [/thin|hairline/, 100], [/extralight|ultralight/, 200], [/semibold|demibold|demi/, 600],
  [/extrabold|ultrabold|heavy/, 800], [/black/, 900], [/light/, 300], [/medium/, 500], [/bold/, 700], [/regular|book|normal|roman/, 400],
];

const WEIGHT_NAMES = { 100: "Thin", 200: "ExtraLight", 300: "Light", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };

// "ABCDEF+OpenSans-SemiBoldItalic" -> { words: ["Open","Sans"], weight: 600, italic: true }
export function parseFontName(fontName, bold, italic) {
  let name = String(fontName || "").replace(/^[A-Z]{6}\+/, "");
  const cut = name.search(/[-,_]/);
  let family = cut > 0 ? name.slice(0, cut) : name;
  let style = cut > 0 ? name.slice(cut + 1) : "";
  family = family.replace(/(PSMT|PS|MT)$/, "");
  // Stile attaccato al nome senza trattino ("ArialBold", "HelveticaNeueLight")
  const tail = family.match(/(Thin|ExtraLight|UltraLight|Light|Regular|Book|Medium|SemiBold|DemiBold|Bold|ExtraBold|Heavy|Black|Italic|Oblique)+$/);
  if (tail && tail.index > 0) { style = tail[0] + style; family = family.slice(0, tail.index); }
  const s = style.toLowerCase();
  let weight = bold ? 700 : 400;
  for (const [re, w] of WEIGHTS) if (re.test(s)) { weight = w; break; }
  const words = family.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/\s+/).filter(Boolean);
  return { words, weight, italic: italic || /italic|oblique|it$/.test(s) };
}

async function getJSON(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } finally { clearTimeout(t); }
}

async function getBytes(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  } finally { clearTimeout(t); }
}

function pickVariant(meta, weight, italic) {
  const weights = meta.weights.slice().sort((a, b) => Math.abs(a - weight) - Math.abs(b - weight) || b - a);
  const w = weights[0];
  const style = italic && meta.styles.includes("italic") ? "italic" : "normal";
  const subset = meta.subsets.includes("latin") ? "latin" : meta.defSubset;
  return { url: meta.variants?.[w]?.[style]?.[subset]?.url?.ttf, weight: w, style };
}

// Cerca il font in rete. Ritorna { bytes, exact, label } oppure null.
export async function fetchWebFont(fontName, { bold = false, italic = false } = {}) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
  const { words, weight, italic: it } = parseFontName(fontName, bold, italic);
  if (!words.length) return null;
  const key = norm(words.join(""));
  // Prima il font stesso (stesso disegno), poi l'eventuale gemello open
  const ids = [...new Set([words.join("-").toLowerCase(), key, words.slice(0, -1).join("-").toLowerCase()].filter(Boolean))];
  // I font commerciali non sono nei cataloghi open: si va diretti al gemello
  const tries = TWINS[key] ? [{ id: TWINS[key], exact: false }] : ids.map((id) => ({ id, exact: true }));
  for (const { id, exact } of tries) {
    let meta;
    try { meta = await getJSON(API + encodeURIComponent(id)); } catch { meta = null; }
    if (!meta?.variants) continue;
    // Per i nomi commerciali il catalogo non ha il font vero: si salta al gemello
    if (exact && norm(meta.family) !== key && norm(meta.family) !== norm(words.slice(0, -1).join(""))) continue;
    const v = pickVariant(meta, weight, it);
    if (!v.url) continue;
    let bytes;
    try { bytes = await getBytes(v.url); } catch { bytes = null; }
    if (!bytes) continue;
    const styleLabel = `${WEIGHT_NAMES[v.weight] ? " " + WEIGHT_NAMES[v.weight] : ""}${v.style === "italic" ? " Italic" : ""}`;
    return { bytes, exact, family: meta.family, label: meta.family + styleLabel, category: meta.category };
  }
  return null;
}
