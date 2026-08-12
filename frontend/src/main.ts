import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./styles/tailwind.css";
// KaTeX stylesheet for math rendered by markdown-it-texmath in render/markdown.ts.
// Imported eagerly so the first assistant bubble with math doesn't FOUC.
import "katex/dist/katex.min.css";
import { initPwaInstall } from "./util/pwa-install.js";
import { initStandalonePwaOrientationLock } from "./util/pwa-orientation.js";
import { watchForFrontendUpdates } from "./util/frontend-update.js";
import { useDraftsStore } from "./stores/drafts.js";
import { useImageDraftsStore } from "./stores/image-drafts.js";
import { useSessionsStore } from "./stores/sessions.js";
import { useUiStore } from "./stores/ui.js";

// Capture the one-shot browser event before mounting any UI. Settings may not
// be opened until long after beforeinstallprompt has fired.
initPwaInstall();
initStandalonePwaOrientationLock();
const pinia = createPinia();
createApp(App).use(pinia).mount("#app");

function canReloadForFrontendUpdate(): boolean {
  const drafts = useDraftsStore(pinia);
  const imageDrafts = useImageDraftsStore(pinia);
  const sessions = useSessionsStore(pinia);
  const ui = useUiStore(pinia);
  const selectedId = ui.selectedSessionId;
  const composerFocused = document.activeElement instanceof HTMLTextAreaElement;
  const focusedComposerHasDraft = composerFocused
    && !!selectedId
    && drafts.text(selectedId).length > 0;
  const hasInflightSend = Object.values(drafts.inflightBySession).some(count => count > 0);
  const hasUnpersistedImages = Object.values(imageDrafts.bySession).some(items => items.length > 0);
  const selectedSessionRunning = !!selectedId && sessions.statusBySession[selectedId] === "running";
  return !focusedComposerHasDraft && !hasInflightSend && !hasUnpersistedImages && !selectedSessionRunning;
}

// PWA installation requires a secure context (HTTPS, except localhost).
// Register only in production so local Vite development never gains a stale
// service worker that masks source changes.
if (import.meta.env.PROD && window.isSecureContext && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        watchForFrontendUpdates(registration, canReloadForFrontendUpdate);
      })
      .catch((error: unknown) => {
        console.warn("Agent WebUI service worker registration failed", error);
      });
  }, { once: true });
}
