import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureNotifyPermission, osNotify, requestNotifyPermission } from "../src/util/os-notify.js";
import { dismissSessionNotification } from "../src/util/pwa-notifications.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OS notification permission", () => {
  it("does not prompt during startup capability detection", () => {
    const requestPermission = vi.fn();
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    expect(ensureNotifyPermission()).toBe("default");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("requests permission only through the explicit user action", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    await expect(requestNotifyPermission()).resolves.toBe("granted");
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("uses a persistent service-worker notification on mobile", async () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const showNotification = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({ showNotification }),
      },
    });

    await osNotify({ sessionId: "mobile-session", title: "Agent WebUI", body: "Reply finished" });

    expect(showNotification).toHaveBeenCalledWith("Agent WebUI", expect.objectContaining({
      tag: "agent-webui-session:mobile-session",
      renotify: true,
      data: { kind: "session", sessionId: "mobile-session" },
    }));
  });

  it("closes the persistent notification when its session is read", async () => {
    const close = vi.fn();
    const getNotifications = vi.fn().mockResolvedValue([{ close }]);
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({ getNotifications }),
      },
    });

    await dismissSessionNotification("mobile-session");

    expect(getNotifications).toHaveBeenCalledWith({
      tag: "agent-webui-session:mobile-session",
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
