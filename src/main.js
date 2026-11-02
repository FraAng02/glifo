import { call } from "./rpc.js";
import { norm } from "./engine/norm.js";
import { saveFile, isTouch, isElectron, isNative } from "./platform.js";
import { listFonts, addFontFiles, removeFont, systemFonts, resolveFont, forgetResolved } from "./fonts.js";

const $ = (id) => document.getElementById(id);
const PT = 96 / 72; // px CSS per punto tipografico a zoom 100%
const mobile = () => matchMedia("(max-width: 820px)").matches;
const cleanFont = (n) => String(n || "").replace(/^[A-Z]{6}\+/, "").replace(/[-_,]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+MT$|\s+PS$/, "").trim();

if (window.glifo?.platform === "darwin") document.body.classList.add("mac-app");
if (isElectron || isNative) $("installLink")?.remove();

const state = {
  name: "", pages: [], zoom: 1, fit: true, reveal: false,
  spans: new Map(), rendered: new Map(), thumbs: new Set(),
  sel: null, history: [], redo: [], current: 0,
};

// ============ Tema ============
const THEME = "glifo.theme";
function applyTheme(t) {
  const theme = t || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
}
try { applyTheme(localStorage.getItem(THEME)); } catch { applyTheme(); }
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { try { if (!localStorage.getItem(THEME)) applyTheme(); } catch { applyTheme(); } });
$("themeBtn").onclick = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem(THEME, next); } catch {}
};

// ============ Toast e attesa ============
function toast(msg, kind = "ok", ms = 3200) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<i></i><span></span>`;
  el.lastChild.textContent = msg;
  $("toasts").append(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, ms);
}
const busy = (text) => { $("busy").hidden = !text; if (text) $("busyText").textContent = text; };

// ============ Coda di rendering (il worker è seriale: prima le pagine visibili) ============
const queue = new Map();
let draining = false;
function enqueue(key, prio, fn) {
  if (!queue.has(key)) queue.set(key, { prio, fn });
  else queue.get(key).prio = Math.max(queue.get(key).prio, prio);
  drain();
}
async function drain() {
  if (draining) return;
  draining = true;
  while (queue.size) {
    let best = null;
    for (const [k, j] of queue) if (!best || j.prio > best[1].prio) best = [k, j];
    queue.delete(best[0]);
    try { await best[1].fn(); } catch (e) { console.error(e); }
  }
  draining = false;
}
const pngUrl = (bytes) => URL.createObjectURL(new Blob([bytes], { type: "image/png" }));

// ============ Apertura ============
async function openFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return toast("Questo file non è un PDF", "err");
  busy("Apertura del documento…");
  try {
    const data = await file.arrayBuffer();
    const info = await call("open", { data }, [data]);
    Object.assign(state, {
      name: file.name.replace(/\.pdf$/i, ""), pages: info.pages, fit: true, sel: null,
      history: [], redo: [], current: 0,
    });
    state.spans.clear(); state.rendered.clear(); state.thumbs.clear(); queue.clear();
    $("welcome").hidden = true;
    $("editor").hidden = false;
    $("docName").textContent = state.name;
    $("docMeta").textContent = `${info.pages.length} ${info.pages.length === 1 ? "pagina" : "pagine"}`;
    buildPages();
    buildRail();
    showInspector(null);
    updateHistory();
  } catch (e) {
    console.error(e);
    toast("Impossibile aprire il PDF: " + e.message, "err", 5000);
  } finally {
    busy(null);
  }
}

$("file").onchange = (e) => { openFile(e.target.files[0]); e.target.value = ""; };
$("close").onclick = () => {
  if (state.history.length && !confirm("Chiudere il documento? Le modifiche non esportate andranno perse.")) return;
  deselect();
  $("editor").hidden = true;
  $("welcome").hidden = false;
  $("pages").innerHTML = ""; $("rail").innerHTML = "";
};

// ============ Pagine ============
let pageObserver, thumbObserver, visObserver;
const pageEl = (pno) => $("pages").children[pno];

function fitZoom() {
  const avail = $("canvas").clientWidth - (mobile() ? 24 : 72);
  const maxW = Math.max(...state.pages.map((p) => p.width));
  return Math.max(0.25, Math.min(avail / (maxW * PT), mobile() ? 3 : 1.25));
}

function layout() {
  if (state.fit) state.zoom = fitZoom();
  [...$("pages").children].forEach((el, i) => {
    el.style.width = `${state.pages[i].width * PT * state.zoom}px`;
    el.style.height = `${state.pages[i].height * PT * state.zoom}px`;
  });
  $("zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
  clearTimeout(layout.t);
  layout.t = setTimeout(() => [...$("pages").children].forEach((el, i) => { if (el.dataset.visible) requestRender(i); }), 220);
}

function buildPages() {
  const pages = $("pages");
  pages.innerHTML = "";
  pages.classList.toggle("reveal", state.reveal);
  state.pages.forEach((_, i) => {
    const el = document.createElement("div");
    el.className = "page loading";
    el.dataset.pno = i;
    el.innerHTML = `<img class="base" alt=""><div class="layer"></div><div class="num">${i + 1}</div>`;
    pages.append(el);
  });
  layout();
  pageObserver?.disconnect();
  pageObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const pno = +e.target.dataset.pno;
      if (e.isIntersecting) { e.target.dataset.visible = "1"; requestRender(pno); }
      else delete e.target.dataset.visible;
    }
  }, { root: $("canvas"), rootMargin: "800px 0px" });
  visObserver?.disconnect();
  const ratios = new Map();
  visObserver = new IntersectionObserver((entries) => {
    for (const e of entries) ratios.set(+e.target.dataset.pno, e.intersectionRatio);
    let best = 0, cur = state.current;
    for (const [p, r] of ratios) if (r > best) { best = r; cur = p; }
    setCurrent(cur);
  }, { root: $("canvas"), threshold: [0, 0.25, 0.5, 0.75, 1] });
  [...pages.children].forEach((el) => { pageObserver.observe(el); visObserver.observe(el); });
  $("canvas").scrollTo(0, 0);
}

function renderScale() {
  return Math.min(state.zoom * PT * Math.min(devicePixelRatio || 1, 3), 6);
}

function requestRender(pno, force = false) {
  const scale = renderScale();
  if (!force && (state.rendered.get(pno) || 0) >= scale * 0.95) return;
  enqueue(`page-${pno}`, 10 + (pageEl(pno)?.dataset.visible ? 5 : 0) - Math.abs(pno - state.current) * 0.01, async () => {
    const s = renderScale();
    const [png, spans] = await Promise.all([
      call("render", { pno, scale: s }),
      state.spans.has(pno) && !force ? state.spans.get(pno) : call("spans", { pno }),
    ]);
    state.spans.set(pno, spans);
    state.rendered.set(pno, s);
    const el = pageEl(pno);
    if (!el) return;
    const img = el.querySelector("img.base");
    const old = img.src;
    img.src = pngUrl(png);
    img.decode?.().catch(() => {}).finally(() => old && URL.revokeObjectURL(old));
    el.classList.remove("loading");
    drawLayer(pno);
  });
}

function drawLayer(pno) {
  const el = pageEl(pno);
  const layer = el.querySelector(".layer");
  const { width, height } = state.pages[pno];
  const pct = (v, total) => `${(v / total) * 100}%`;
  layer.innerHTML = "";
  for (const s of state.spans.get(pno) || []) {
    const [x0, y0, x1, y1] = s.bbox;
    const d = document.createElement("div");
    d.className = "span";
    d.dataset.index = s.index;
    Object.assign(d.style, { left: pct(x0, width), top: pct(y0, height), width: pct(x1 - x0, width), height: pct(y1 - y0, height) });
    layer.append(d);
  }
  for (const h of state.history.filter((h) => h.pno === pno)) {
    const m = document.createElement("div");
    m.className = "proofmark";
    // nel margine sinistro, come il segno di un correttore di bozze
    Object.assign(m.style, { left: pct(Math.min(16, h.bbox[0] / 2), width), top: pct((h.bbox[1] + h.bbox[3]) / 2, height) });
    layer.append(m);
  }
}

function setCurrent(pno) {
  state.current = pno;
  $("pageChip").textContent = `${pno + 1} / ${state.pages.length}`;
  document.querySelectorAll(".thumb").forEach((t, i) => t.classList.toggle("active", i === pno));
  const t = $("rail").children[pno];
  if (t && !mobile()) {
    const r = t.getBoundingClientRect(), rr = $("rail").getBoundingClientRect();
    if (r.top < rr.top + 80 || r.bottom > rr.bottom) t.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

// ============ Miniature ============
function buildRail() {
  const rail = $("rail");
  rail.innerHTML = "";
  state.pages.forEach((p, i) => {
    const b = document.createElement("button");
    b.className = "thumb";
    b.dataset.pno = i;
    b.innerHTML = `<span class="tframe" style="aspect-ratio:${p.width}/${p.height}"><img alt=""></span>${i + 1}`;
    b.onclick = () => pageEl(i).scrollIntoView({ behavior: "smooth", block: "start" });
    rail.append(b);
  });
  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) renderThumb(+e.target.dataset.pno);
  }, { root: rail, rootMargin: "400px 0px" });
  [...rail.children].forEach((t) => thumbObserver.observe(t));
}

function renderThumb(pno, force = false) {
  if (getComputedStyle($("rail")).display === "none") return;
  if (state.thumbs.has(pno) && !force) return;
  state.thumbs.add(pno);
  enqueue(`thumb-${pno}`, 1, async () => {
    const png = await call("render", { pno, scale: 220 / state.pages[pno].width });
    const img = $("rail").children[pno]?.querySelector("img");
    if (!img) return;
    const old = img.src;
    img.src = pngUrl(png);
    if (old) URL.revokeObjectURL(old);
  });
}

// ============ Selezione e modifica ============
$("pages").addEventListener("click", (e) => {
  const s = e.target.closest(".span");
  if (!s) { if (!e.target.closest(".page") || state.sel) deselect(); return; }
  select(+s.closest(".page").dataset.pno, +s.dataset.index);
});

let pvTimer = 0, pvBusy = false, pvAgain = false;

async function select(pno, index) {
  const span = state.spans.get(pno)?.[index];
  if (!span) return;
  deselect(true);
  const el = pageEl(pno);
  const box = el.querySelector(`.span[data-index="${index}"]`);
  box.classList.add("selected");
  const tag = document.createElement("div");
  tag.className = "tag";
  tag.textContent = `${cleanFont(span.fontName)} · ${span.size.toFixed(1)} pt`;
  Object.assign(tag.style, { left: box.style.left, top: box.style.top });
  el.querySelector(".layer").append(tag);
  state.sel = { pno, index, span, box, tag, kind: null, preview: null };
  showInspector(span, pno);
  const r = box.getBoundingClientRect(), c = $("canvas").getBoundingClientRect();
  const bottomLimit = mobile() ? c.bottom - window.innerHeight * 0.5 : c.bottom - 40;
  if (r.top < c.top + 90 || r.bottom > bottomLimit) {
    $("canvas").scrollBy({ top: r.top - c.top - (mobile() ? 120 : c.height / 3), behavior: "smooth" });
  }
  const sel = state.sel;
  const bytes = await resolveFont(span.fontName);
  if (bytes && state.sel === sel) await call("registerFont", { key: norm(span.fontName), data: bytes.slice() });
  if (state.sel === sel) runPreview();
}

function deselect(keepSheet = false) {
  const sel = state.sel;
  if (!sel) return;
  sel.box?.classList.remove("selected");
  sel.tag?.remove();
  sel.preview?.remove();
  if (sel.preview?.src) URL.revokeObjectURL(sel.preview.src);
  state.sel = null;
  if (!keepSheet) showInspector(null);
}

function showInspector(span, pno) {
  $("inspEmpty").hidden = !!span;
  $("inspEdit").hidden = !span;
  $("inspector").classList.toggle("open", !!span);
  if (!span) { $("editInput").blur(); return; }
  $("selPage").textContent = pno + 1;
  $("selFont").textContent = cleanFont(span.fontName) || "Font senza nome";
  $("selSize").textContent = `${span.size.toFixed(1)} pt`;
  const c = span.color;
  const rgb = c.length === 4
    ? c.slice(0, 3).map((v) => 255 * (1 - v) * (1 - c[3]))
    : (c.length === 1 ? [c[0], c[0], c[0]] : c).map((v) => v * 255);
  $("selColor").style.background = `rgb(${rgb.map(Math.round).join(",")})`;
  $("selStyle").textContent = [span.bold && "Grassetto", span.italic && "Corsivo"].filter(Boolean).join(" · ") || "Regolare";
  $("selOrig").textContent = span.text.trim();
  setBadge("pending");
  const input = $("editInput");
  input.value = span.text.trim() === span.text ? span.text : span.text.trim();
  input.dataset.lead = span.text.match(/^\s*/)[0];
  input.dataset.trail = span.text.match(/\s*$/)[0];
  if (!isTouch || mobile()) {
    input.focus({ preventScroll: true });
    if (!isTouch) input.select();
  }
}

const BADGES = {
  pending: "Analisi del font…",
  original: "Font originale del PDF",
  embedded: "Font originale (incorporato)",
  library: "Stesso font · versione completa",
  similar: "Sostituito con un font simile",
};
function setBadge(kind, extra) {
  const b = $("selBadge");
  b.dataset.kind = kind;
  b.lastElementChild.textContent = kind === "similar" && extra ? `Sostituito con ${extra}` : BADGES[kind];
  b.title = kind === "similar"
    ? "Il PDF non contiene tutte le lettere di questo font e il font non è installato. Aggiungilo alla libreria per un risultato identico."
    : "";
  $("addFontCta").hidden = kind !== "similar";
}

const fullText = () => {
  const input = $("editInput");
  return input.dataset.lead + input.value + input.dataset.trail;
};

function schedulePreview() {
  clearTimeout(pvTimer);
  pvTimer = setTimeout(runPreview, 60);
}

async function runPreview() {
  const sel = state.sel;
  if (!sel) return;
  if (pvBusy) { pvAgain = true; return; }
  pvBusy = true;
  try {
    const text = fullText();
    const r = await call("preview", { pno: sel.pno, index: sel.index, text, scale: renderScale() });
    if (state.sel !== sel) return;
    sel.kind = r.kind;
    setBadge(r.kind, r.fontLabel);
    if (text === sel.span.text) { sel.preview?.remove(); sel.preview = null; return; }
    const { width, height } = state.pages[sel.pno];
    const img = sel.preview || document.createElement("img");
    const [x0, y0, x1, y1] = r.rect;
    const url = pngUrl(r.png);
    const old = img.src;
    img.className = "preview";
    Object.assign(img.style, { left: `${(x0 / width) * 100}%`, top: `${(y0 / height) * 100}%`, width: `${((x1 - x0) / width) * 100}%`, height: `${((y1 - y0) / height) * 100}%` });
    img.src = url;
    if (old) img.decode?.().catch(() => {}).finally(() => URL.revokeObjectURL(old));
    if (!sel.preview) { pageEl(sel.pno).querySelector(".layer").prepend(img); sel.preview = img; }
  } catch (e) {
    console.error(e);
  } finally {
    pvBusy = false;
    if (pvAgain) { pvAgain = false; runPreview(); }
  }
}

async function apply() {
  const sel = state.sel;
  if (!sel) return null;
  const text = fullText();
  if (text === sel.span.text) { deselect(); return null; }
  clearTimeout(pvTimer);
  try {
    const r = await call("edit", { pno: sel.pno, index: sel.index, text });
    state.history.push({ pno: sel.pno, bbox: sel.span.bbox, old: sel.span.text.trim(), text: text.trim(), kind: r.kind });
    state.redo = [];
    deselect();
    await refreshPage(sel.pno);
    if (r.kind === "similar") toast(`Lettere non presenti nel font originale: usato ${r.fontLabel}`, "warn", 5000);
    updateHistory();
    return sel;
  } catch (e) {
    toast("Modifica non riuscita: " + e.message, "err", 5000);
    return null;
  }
}

async function refreshPage(pno) {
  state.spans.delete(pno);
  state.rendered.delete(pno);
  await new Promise((resolve) => {
    enqueue(`page-${pno}`, 100, async () => {
      const s = renderScale();
      const [png, spans] = await Promise.all([call("render", { pno, scale: s }), call("spans", { pno })]);
      state.spans.set(pno, spans);
      state.rendered.set(pno, s);
      const img = pageEl(pno).querySelector("img.base");
      const old = img.src;
      img.src = pngUrl(png);
      await img.decode?.().catch(() => {});
      if (old) URL.revokeObjectURL(old);
      drawLayer(pno);
      resolve();
    });
  });
  renderThumb(pno, true);
}

// Scritta successiva in ordine di lettura (anche sulle pagine seguenti)
function neighbour(pno, bbox, step) {
  const order = (s) => [Math.round(s.bbox[1] / 2), s.bbox[0]];
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1];
  const here = [Math.round(bbox[1] / 2), bbox[0]];
  for (let p = pno; p >= 0 && p < state.pages.length; p += step) {
    const list = [...(state.spans.get(p) || [])].sort((a, b) => cmp(order(a), order(b)));
    if (step < 0) list.reverse();
    const hit = p === pno ? list.find((s) => cmp(order(s), here) * step > 0) : list[0];
    if (hit) return { pno: p, index: hit.index };
  }
  return null;
}

async function applyAndMove(step) {
  const sel = state.sel;
  if (!sel) return;
  const { pno, span } = sel;
  if (fullText() !== span.text) await apply(); else deselect(true);
  const next = neighbour(pno, span.bbox, step);
  if (next) select(next.pno, next.index); else showInspector(null);
}

$("editInput").addEventListener("input", schedulePreview);
$("editInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); apply(); }
  else if (e.key === "Escape") { e.preventDefault(); deselect(); }
  else if (e.key === "Tab") { e.preventDefault(); applyAndMove(e.shiftKey ? -1 : 1); }
});
$("applyEdit").onclick = apply;
$("cancelEdit").onclick = () => deselect();
$("addFontCta").onclick = openFonts;

// ============ Cronologia ============
function updateHistory() {
  const can = { undo: state.history.length > 0, redo: state.redo.length > 0 };
  $("undo").disabled = $("mUndo").disabled = !can.undo;
  $("redo").disabled = $("mRedo").disabled = !can.redo;
  $("historyWrap").hidden = !state.history.length;
  $("histCount").textContent = state.history.length ? `· ${state.history.length}` : "";
  const ol = $("history");
  ol.innerHTML = "";
  [...state.history].reverse().slice(0, 30).forEach((h) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="hp">p.${h.pno + 1}</span><span class="hnew"></span><span class="hold"></span>`;
    li.children[1].textContent = h.text || "(testo rimosso)";
    li.children[2].textContent = h.old;
    li.onclick = () => pageEl(h.pno).scrollIntoView({ behavior: "smooth", block: "center" });
    ol.append(li);
  });
  document.querySelectorAll(".thumb").forEach((t, i) => {
    const has = state.history.some((h) => h.pno === i);
    const frame = t.querySelector(".tframe");
    if (has && !frame.querySelector(".tdot")) frame.insertAdjacentHTML("beforeend", '<i class="tdot"></i>');
    if (!has) frame.querySelector(".tdot")?.remove();
  });
}

async function undo() {
  deselect();
  const pno = await call("undo");
  if (pno === null) return;
  state.redo.push(state.history.pop());
  await refreshPage(pno);
  updateHistory();
}
async function redo() {
  deselect();
  const pno = await call("redo");
  if (pno === null) return;
  state.history.push(state.redo.pop());
  await refreshPage(pno);
  updateHistory();
}
$("undo").onclick = $("mUndo").onclick = undo;
$("redo").onclick = $("mRedo").onclick = redo;

// ============ Esportazione ============
async function exportPdf() {
  if (state.sel && fullText() !== state.sel.span.text) await apply();
  busy("Preparazione del PDF…");
  try {
    const bytes = await call("save");
    busy(null);
    const ok = await saveFile(`${state.name}-modificato.pdf`, bytes);
    if (ok) toast(isElectron || isNative ? "PDF salvato" : "PDF esportato");
  } catch (e) {
    toast("Esportazione non riuscita: " + e.message, "err", 5000);
  } finally {
    busy(null);
  }
}
$("export").onclick = exportPdf;

// ============ Zoom ============
function setZoom(z, anchor) {
  const canvas = $("canvas");
  const rect = canvas.getBoundingClientRect();
  const ax = anchor ? anchor.x - rect.left : canvas.clientWidth / 2;
  const ay = anchor ? anchor.y - rect.top : canvas.clientHeight / 2;
  const fx = (canvas.scrollLeft + ax) / canvas.scrollWidth, fy = (canvas.scrollTop + ay) / canvas.scrollHeight;
  state.fit = false;
  state.zoom = Math.max(0.25, Math.min(5, z));
  layout();
  canvas.scrollLeft = fx * canvas.scrollWidth - ax;
  canvas.scrollTop = fy * canvas.scrollHeight - ay;
}
$("zoomIn").onclick = () => setZoom(state.zoom * 1.2);
$("zoomOut").onclick = () => setZoom(state.zoom / 1.2);
$("zoomLabel").onclick = () => { state.fit = true; layout(); };
$("canvas").addEventListener("wheel", (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setZoom(state.zoom * Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY });
}, { passive: false });
let pinch = null;
$("canvas").addEventListener("touchstart", (e) => {
  if (e.touches.length !== 2) return;
  const [a, b] = e.touches;
  pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: state.zoom };
}, { passive: true });
$("canvas").addEventListener("touchmove", (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const [a, b] = e.touches;
  const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  setZoom(pinch.z * (d / pinch.d), { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
}, { passive: false });
$("canvas").addEventListener("touchend", () => { pinch = null; });
document.addEventListener("gesturestart", (e) => e.preventDefault());
addEventListener("resize", () => { if (!$("editor").hidden && state.fit) layout(); });

// ============ Mostra scritte ============
function toggleReveal() {
  state.reveal = !state.reveal;
  $("pages").classList.toggle("reveal", state.reveal);
  $("reveal").setAttribute("aria-pressed", state.reveal);
  $("mReveal").classList.toggle("on", state.reveal);
}
$("reveal").onclick = $("mReveal").onclick = toggleReveal;

// ============ Libreria font ============
async function renderFontList() {
  const fonts = await listFonts();
  const ul = $("fontList");
  ul.innerHTML = "";
  for (const f of fonts) {
    const li = document.createElement("li");
    li.innerHTML = `<span></span><button type="button" class="icon-btn" aria-label="Rimuovi"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    li.firstChild.textContent = f.label;
    li.firstChild.insertAdjacentHTML("beforeend", `<small>${Math.round(f.bytes.length / 1024)} KB</small>`);
    li.lastChild.onclick = async () => { await removeFont(f.id); forgetResolved(); renderFontList(); };
    ul.append(li);
  }
  const sys = $("sysFonts");
  sys.hidden = !systemFonts.supported;
  $("sysEnable").hidden = systemFonts.enabled;
  $("sysStatus").textContent = systemFonts.enabled ? "Attivi: Glifo usa automaticamente i font installati." : "Usa automaticamente i font installati.";
}
function openFonts() { renderFontList(); $("fontsDialog").showModal(); }
$("fontsBtn").onclick = $("mFonts").onclick = openFonts;
$("sysEnable").onclick = async () => {
  try { await systemFonts.enable(); forgetResolved(); toast("Font di sistema attivati"); }
  catch { toast("Accesso ai font non consentito", "err"); }
  renderFontList();
};
async function addFonts(files) {
  const n = await addFontFiles(files);
  forgetResolved();
  toast(n ? `${n} ${n === 1 ? "font aggiunto" : "font aggiunti"}` : "Nessun font valido", n ? "ok" : "err");
  renderFontList();
  if (state.sel) select(state.sel.pno, state.sel.index);
}
$("fontFile").onchange = (e) => { addFonts([...e.target.files]); e.target.value = ""; };
$("fontsDialog").addEventListener("click", (e) => { if (e.target === $("fontsDialog")) $("fontsDialog").close(); });

// ============ Trascinamento file ============
let dragDepth = 0;
const isFontFile = (f) => /\.(ttf|otf|ttc)$/i.test(f.name);
addEventListener("dragenter", (e) => { e.preventDefault(); if (++dragDepth === 1) { $("dropveil").hidden = false; $("drop").classList.add("over"); } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("dropveil").hidden = true; $("drop").classList.remove("over"); } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0; $("dropveil").hidden = true; $("drop").classList.remove("over");
  const files = [...(e.dataTransfer?.files || [])];
  const fonts = files.filter(isFontFile);
  if (fonts.length) addFonts(fonts);
  const pdf = files.find((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  if (pdf) { if (state.history.length && !confirm("Aprire un nuovo PDF? Le modifiche non esportate andranno perse.")) return; openFile(pdf); }
});

// ============ Tastiera virtuale (mobile): il pannello resta sopra la tastiera ============
if (window.visualViewport) {
  const vv = window.visualViewport;
  const update = () => {
    const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty("--kb", `${kb}px`);
    document.body.classList.toggle("kb-open", kb > 80);
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
}

// ============ Tastiera ============
addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const typing = e.target.matches?.("input, textarea");
  if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); $("file").click(); return; }
  if ($("editor").hidden) return;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); exportPdf(); }
  else if (mod && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && (e.key === "+" || e.key === "=")) { e.preventDefault(); setZoom(state.zoom * 1.2); }
  else if (mod && e.key === "-") { e.preventDefault(); setZoom(state.zoom / 1.2); }
  else if (mod && e.key === "0") { e.preventDefault(); state.fit = true; layout(); }
  else if (!typing && !mod && e.key.toLowerCase() === "t") toggleReveal();
  else if (!typing && e.key === "Escape") deselect();
});

// Electron: file aperti dal Finder/Esplora risorse ("Apri con")
window.glifo?.onOpenFile?.((name, bytes) => openFile(new File([bytes], name, { type: "application/pdf" })));

// ============ PWA offline ============
if ("serviceWorker" in navigator && location.protocol === "https:" && !isNative) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// ============ Solo sviluppo: scenario automatico per screenshot (#test?pdf=…&find=…&type=…) ============
if ((import.meta.env.DEV && location.hash.startsWith("#test")) || import.meta.env.VITE_SELFTEST) {
  const p = new URLSearchParams(import.meta.env.VITE_SELFTEST || location.hash.slice(6));
  if (p.get("theme")) applyTheme(p.get("theme"));
  if (p.get("pdf")) {
    const blob = await (await fetch(p.get("pdf"))).blob();
    await openFile(new File([blob], p.get("name") || "Fattura 2026-118.pdf", { type: "application/pdf" }));
    if (p.get("find")) {
      while (!state.spans.has(0)) await new Promise((r) => setTimeout(r, 50));
      const s = state.spans.get(0).find((s) => s.text.includes(p.get("find")));
      await select(0, s.index);
      if (p.get("type")) { $("editInput").value = p.get("type"); runPreview(); }
      if (p.get("apply")) { await new Promise((r) => setTimeout(r, 300)); await apply(); }
    }
  }
}
