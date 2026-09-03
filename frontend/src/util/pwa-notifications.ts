const SESSION_NOTIFICATION_TAG_PREFIX = "agent-webui-session:";

export function sessionNotificationTag(sessionId: string): string {
  return `${SESSION_NOTIFICATION_TAG_PREFIX}${sessionId}`;
}

async function currentRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
  try {
    return await navigator.serviceWorker.getRegistration();
  } catch {
    return undefined;
  }
}

// Mobile browsers generally reject `new Notification()`. A persistent
// notification created by the service worker is the portable path and, on
// Android, is also what lets the launcher show an unread dot/count.
export async function showSessionNotification(input: {
  sessionId: string;
  title: string;
  body: string;
}): Promise<boolean> {
  const registration = await currentRegistration();
  if (!registration) return false;
  try {
    // `renotify` is implemented by Chromium for persistent notifications but
    // is still missing from some TypeScript DOM-lib releases.
    const options: NotificationOptions & { renotify: boolean } = {
      body: input.body.slice(0, 200),
      tag: sessionNotificationTag(input.sessionId),
      renotify: true,
      icon: "/assets/icon-192.png",
      data: { kind: "session", sessionId: input.sessionId },
    };
    await registration.showNotification(input.title || "Agent WebUI", options);
    return true;
  } catch {
    return false;
  }
}

// Reading a conversation must settle both representations of unread state:
// the in-app count and any persistent OS notification that keeps an Android
// launcher badge alive.
export async function dismissSessionNotification(sessionId: string): Promise<void> {
  const registration = await currentRegistration();
  if (!registration) return;
  try {
    const notifications = await registration.getNotifications({
      tag: sessionNotificationTag(sessionId),
    });
    for (const notification of notifications) notification.close();
  } catch { /* unsupported or unavailable */ }
}
