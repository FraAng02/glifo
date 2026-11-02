// Il motore gira in un Web Worker: l'interfaccia resta fluida anche su PDF pesanti.
// Il gestore dei messaggi va registrato subito: MuPDF carica il WebAssembly in modo
// asincrono e i messaggi arrivati nel frattempo andrebbero persi.
const ready = import("./engine.js").then(({ Engine }) => new Engine());

const handlers = {
  open: (engine, { data }) => engine.open(data),
  render: (engine, { pno, scale }) => engine.render(pno, scale),
  spans: (engine, { pno }) => engine.publicSpans(pno),
  registerFont: (engine, { key, data, exact, label }) => engine.registerFont(key, data, exact, label),
  preview: (engine, { pno, index, text, scale }) => engine.preview(pno, index, text, scale),
  edit: (engine, { pno, index, text }) => engine.edit(pno, index, text),
  undo: (engine) => engine.undo(),
  redo: (engine) => engine.redo(),
  save: (engine) => engine.save(),
};

// Le richieste vengono eseguite una alla volta, nell'ordine di arrivo
let chain = Promise.resolve();
self.onmessage = ({ data: { id, cmd, args } }) => {
  chain = chain.then(async () => {
    try {
      const engine = await ready;
      let result = handlers[cmd](engine, args || {});
      // Copie: i buffer di MuPDF possono puntare alla memoria WebAssembly
      if (result instanceof Uint8Array) result = result.slice();
      else if (result?.png instanceof Uint8Array) result = { ...result, png: result.png.slice() };
      const transfer = result instanceof Uint8Array ? [result.buffer]
        : result?.png instanceof Uint8Array ? [result.png.buffer] : [];
      self.postMessage({ id, result }, transfer);
    } catch (err) {
      self.postMessage({ id, error: String(err?.message || err) });
    }
  });
};
