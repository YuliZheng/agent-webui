import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dismissAllSessionNotifications,
  dismissSessionNotification,
} from "../src/util/pwa-notifications.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("disabled reply notifications", () => {
  it("closes a legacy persistent notification when its session is read", async () => {
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

  it("clears legacy reply notifications without closing unrelated notifications", async () => {
    const sessionClose = vi.fn();
    const unrelatedClose = vi.fn();
    const getNotifications = vi.fn().mockResolvedValue([
      { tag: "agent-webui-session:mobile-session", close: sessionClose },
      { tag: "another-app-event", close: unrelatedClose },
    ]);
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({ getNotifications }),
      },
    });

    await dismissAllSessionNotifications();

    expect(getNotifications).toHaveBeenCalledWith();
    expect(sessionClose).toHaveBeenCalledTimes(1);
    expect(unrelatedClose).not.toHaveBeenCalled();
  });
});
