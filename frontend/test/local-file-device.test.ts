import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  localDirectoryBehavior,
  setLocalDirectoryBehavior,
  supportsHostDirectoryBehavior,
} from "../src/util/local-file-device.js";

function pointer(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches })),
  });
}

describe("local directory device behavior", () => {
  beforeEach(() => localStorage.clear());

  it("never opens the host file manager from a coarse-pointer device", () => {
    pointer(false);
    setLocalDirectoryBehavior("open-on-host");
    expect(supportsHostDirectoryBehavior()).toBe(false);
    expect(localDirectoryBehavior()).toBe("browse");
  });

  it("persists an explicit per-browser desktop choice", () => {
    pointer(true);
    setLocalDirectoryBehavior("browse");
    expect(localDirectoryBehavior()).toBe("browse");
    setLocalDirectoryBehavior("open-on-host");
    expect(localDirectoryBehavior()).toBe("open-on-host");
  });
});
