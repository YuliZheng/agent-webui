import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

const BACKEND = process.env.CW_BACKEND ?? "http://127.0.0.1:8787";
const KATEX_ENTRY = fileURLToPath(new URL("./node_modules/katex/dist/katex.mjs", import.meta.url));

export default defineConfig({
  plugins: [vue()],
  build: {
    // Standard builds go through scripts/build-frontend-safe.mjs and publish
    // from an isolated staging directory. Keep this disabled as a second line
    // of defence for anyone invoking `vite build` directly: production serves
    // frontend/dist live, so clearing it first would blank the running WebUI.
    emptyOutDir: false,
  },
  resolve: {
    // markdown-it-texmath ships as CommonJS and calls require("katex"), but it
    // only declares KaTeX as a devDependency. In this workspace KaTeX is
    // installed under frontend/node_modules, so Rollup otherwise preserves a
    // bare `import "katex"` in the browser bundle and the SPA fails at startup.
    alias: [{ find: /^katex$/, replacement: KATEX_ENTRY }],
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      // Both API HTTP and SSE go through this proxy. The /api/auth/bind handshake
      // also matches here, which is what makes the cookie land on the 5173 origin.
      "/api": { target: BACKEND, changeOrigin: false, ws: false },
      "/ws": { target: BACKEND, ws: true },
    },
  },
});
