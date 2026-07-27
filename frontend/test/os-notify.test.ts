import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureNotifyPermission, requestNotifyPermission } from "../src/util/os-notify.js";

afterEach(() => vi.unstubAllGlobals());

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
});
