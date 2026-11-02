// Chiamate al motore nel worker, come promesse.
const worker = new Worker(new URL("./engine/worker.js", import.meta.url), { type: "module" });
const pending = new Map();
let seq = 0;

worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  pending.delete(data.id);
  if (data.error) p.reject(new Error(data.error));
  else p.resolve(data.result);
};

// Se il worker non si avvia (es. WebAssembly non supportato) nessuna chiamata resta appesa
worker.onerror = (e) => {
  const err = new Error(e.message || "Il motore PDF non si è avviato");
  console.error(err);
  for (const p of pending.values()) p.reject(err);
  pending.clear();
};

export function call(cmd, args, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, args }, transfer);
  });
}
