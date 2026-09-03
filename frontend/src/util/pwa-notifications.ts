const SESSION_NOTIFICATION_TAG_PREFIX = "agent-webui-session:";

function sessionNotificationTag(sessionId: string): string {
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

// Reply popups are currently disabled. Keep the cleanup path so reading a
// conversation, or loading the updated app, also removes persistent
// notifications created by an older frontend bundle.
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

export async function dismissAllSessionNotifications(): Promise<void> {
  const registration = await currentRegistration();
  if (!registration) return;
  try {
    const notifications = await registration.getNotifications();
    for (const notification of notifications) {
      if (notification.tag.startsWith(SESSION_NOTIFICATION_TAG_PREFIX)) notification.close();
    }
  } catch { /* unsupported or unavailable */ }
}
