// Glifo desktop (macOS / Windows): carica l'app web da dist/ tramite il protocollo app://
const { app, BrowserWindow, protocol, net, ipcMain, dialog, session, nativeTheme, shell } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { pathToFileURL } = require("url");

const DIST = path.join(__dirname, "..", "dist");
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self' blob:",
  "img-src 'self' blob: data:", "style-src 'self' 'unsafe-inline'", "connect-src 'self' blob: data:", "font-src 'self' data:",
].join("; ");

let win = null;
let pendingFiles = [];

let loaded = false;

async function sendFile(file) {
  if (!/\.pdf$/i.test(file)) return;
  if (!win || !loaded) { pendingFiles.push(file); return; }
  const bytes = await fs.readFile(file);
  win.webContents.send("open-file", path.basename(file), bytes);
  if (win.isMinimized()) win.restore();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 720, minHeight: 520,
    title: "Glifo",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#121110" : "#efece6",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 22 },
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.loadURL("app://glifo/index.html");
  win.webContents.on("did-finish-load", () => {
    loaded = true;
    const files = pendingFiles; pendingFiles = [];
    files.forEach(sendFile);
  });
  // I link esterni si aprono nel browser, mai dentro l'app
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("app://")) e.preventDefault(); });
  win.on("closed", () => { win = null; loaded = false; });
}

// macOS: file aperti dal Finder ("Apri con", trascinati sull'icona)
app.on("open-file", (e, file) => { e.preventDefault(); sendFile(file); });

// Windows: il file arriva come argomento; una seconda istanza lo passa alla prima
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", (_e, argv) => argv.slice(1).forEach(sendFile));
pendingFiles.push(...process.argv.slice(1).filter((a) => /\.pdf$/i.test(a)));

ipcMain.handle("save-file", async (_e, name, bytes) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath("documents"), name),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, Buffer.from(bytes));
  return filePath;
});

app.whenReady().then(() => {
  protocol.handle("app", (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString()).then((res) => {
      if (!file.endsWith(".html")) return res;
      const headers = new Headers(res.headers);
      headers.set("Content-Security-Policy", CSP);
      return new Response(res.body, { status: res.status, headers });
    });
  });
  // Contenuto solo locale: permessi concessi (serve per l'accesso ai font installati)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);
  createWindow();
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
