import { describe, expect, it, vi } from "vitest";
import {
  lockStandalonePwaOrientation,
  PWA_ORIENTATION,
  type OrientationLockTarget,
} from "../src/util/pwa-orientation.js";

describe("standalone PWA orientation", () => {
  it("locks an installed PWA to the primary portrait orientation", async () => {
    const lock = vi.fn().mockResolvedValue(undefined);

    await expect(lockStandalonePwaOrientation(true, { lock })).resolves.toBe(true);
    expect(lock).toHaveBeenCalledWith(PWA_ORIENTATION);
  });

  it("does not lock ordinary browser tabs", async () => {
    const lock = vi.fn().mockResolvedValue(undefined);

    await expect(lockStandalonePwaOrientation(false, { lock })).resolves.toBe(false);
    expect(lock).not.toHaveBeenCalled();
  });

  it("quietly tolerates platforms that reject orientation locking", async () => {
    const orientation: OrientationLockTarget = {
      lock: vi.fn().mockRejectedValue(new Error("not supported")),
    };

    await expect(lockStandalonePwaOrientation(true, orientation)).resolves.toBe(false);
  });

  it("falls back to the broader portrait lock for older Android runtimes", async () => {
    const lock = vi.fn()
      .mockRejectedValueOnce(new Error("specific value rejected"))
      .mockResolvedValueOnce(undefined);

    await expect(lockStandalonePwaOrientation(true, { lock })).resolves.toBe(true);
    expect(lock).toHaveBeenNthCalledWith(1, "portrait-primary");
    expect(lock).toHaveBeenNthCalledWith(2, "portrait");
  });
});
