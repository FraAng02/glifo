import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: { target: "esnext", outDir: "dist", assetsInlineLimit: 0, chunkSizeWarningLimit: 2000 },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["mupdf"] },
});
