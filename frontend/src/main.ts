import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./styles/tailwind.css";
// KaTeX stylesheet for math rendered by markdown-it-texmath in render/markdown.ts.
// Imported eagerly so the first assistant bubble with math doesn't FOUC.
import "katex/dist/katex.min.css";
import { initPwaInstall } from "./util/pwa-install.js";
import { initStandalonePwaOrientationLock } from "./util/pwa-orientation.js";

// Capture the one-shot browser event before mounting any UI. Settings may not
// be opened until long after beforeinstallprompt has fired.
initPwaInstall();
initStandalonePwaOrientationLock();
const pinia = createPinia();
createApp(App).use(pinia).mount("#app");

// PWA installation requires a secure context (HTTPS, except localhost).
// Register only in production so local Vite development never gains a stale
// service worker that masks source changes.
if (import.meta.env.PROD && window.isSecureContext && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
      console.warn("Agent WebUI service worker registration failed", error);
    });
  }, { once: true });
}
