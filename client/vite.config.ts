import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { contentPlugin } from "./vite/contentPlugin.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [contentPlugin(path.resolve(here, "../content"))],
  server: { port: 5173, host: "127.0.0.1" },
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: { output: { manualChunks: { three: ["three"] } } },
  },
});
