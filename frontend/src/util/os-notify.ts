// Foreground OS notifications via the Web Notification API. For the installed
// PWA these surface as Windows toast notifications (clearable from the Action
// Center) on top of the taskbar badge. Everything here is a no-op when the
// API is missing or permission isn't granted, so plain browser tabs are
// unaffected. This is foreground-only — no service worker / push — so it fires
// while the app is running (incl. minimized / behind another window), not when
// fully closed.
import { useUiStore } from "../stores/ui.js";

// Startup must not call requestPermission(): Chromium and Safari increasingly
// require a user gesture and may silently suppress an eager prompt. Keep this
// hook as a capability check for App.vue; Settings owns the explicit request.
export function ensureNotifyPermission() {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export async function requestNotifyPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

// Fire a toast for a new assistant reply. Skipped when the window is focused
// AND visible — the in-app toast already covers that case, and an OS toast on
// top would be redundant noise. The point of this is the background /
// minimized case, which is exactly when Windows shows + collects the toast.
export function osNotify(input: { sessionId: string; title: string; body: string }) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    const n = new Notification(input.title || "claude-webui", {
      body: input.body.slice(0, 200),
      tag: input.sessionId, // collapse repeats from the same session
    });
    n.onclick = () => {
      try { window.focus(); } catch { /* ignore */ }
      useUiStore().select(input.sessionId);
      n.close();
    };
  } catch { /* ignore */ }
}
