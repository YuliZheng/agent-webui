// OS notifications for replies received while the installed app is alive in
// the background. The service-worker path works on mobile and lets Android
// launchers derive their notification dot/count; the constructor remains a
// desktop fallback. This is not Web Push, so a fully closed app is still quiet.
import { useUiStore } from "../stores/ui.js";
import { useSessionsStore } from "../stores/sessions.js";
import { sessionNotificationTag, showSessionNotification } from "./pwa-notifications.js";

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

// Fire a system notification for a new assistant reply. Skipped when the
// window is focused and visible because the inline reply is already in view.
export async function osNotify(input: { sessionId: string; title: string; body: string }) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()) return;
  if (await showSessionNotification(input)) return;
  try {
    const n = new Notification(input.title || "Agent WebUI", {
      body: input.body.slice(0, 200),
      tag: sessionNotificationTag(input.sessionId),
      icon: "/assets/icon-192.png",
    });
    n.onclick = () => {
      try { window.focus(); } catch { /* ignore */ }
      useUiStore().select(input.sessionId);
      useSessionsStore().markRead(input.sessionId);
      n.close();
    };
  } catch { /* ignore */ }
}
