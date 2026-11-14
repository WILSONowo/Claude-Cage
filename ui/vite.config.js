import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{
      find: /^@xterm\/xterm$/,
      replacement: fileURLToPath(new URL("./vendor/xterm/xterm-6.0.0-ime.mjs", import.meta.url)),
    }],
  },
  base: "/",
  build: {
    outDir: "../internal/workbench/web",
    emptyOutDir: true,
    rolldownOptions: { input: { desktop: "index.html", mobile: "mobile.html" } },
  },
  server: { proxy: { "/api": { target: "http://localhost:17777", ws: true } } },
});
