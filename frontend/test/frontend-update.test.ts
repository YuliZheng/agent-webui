import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFrontendUpdateCoordinator,
  frontendEntryFromHtml,
} from "../src/util/frontend-update.js";

describe("frontend update coordination", () => {
  afterEach(() => vi.useRealTimers());

  it("extracts the content-hashed application entry from the latest shell", () => {
    expect(frontendEntryFromHtml(
      '<script type="module" crossorigin src="/assets/index-D3nJmD35.js"></script>',
    )).toBe("/assets/index-D3nJmD35.js");
    expect(frontendEntryFromHtml("<html><body>login</body></html>")).toBeNull();
  });

  it("reloads a changed build only after transient composer state is safe", async () => {
    vi.useFakeTimers();
    let safe = false;
    const reload = vi.fn();
    const coordinator = createFrontendUpdateCoordinator({
      canReload: () => safe,
      currentEntry: () => "/assets/index-old.js",
      fetchLatestHtml: async () => '<script type="module" src="/assets/index-new.js"></script>',
      reload,
      reloadGraceMs: 0,
      reloadRetryMs: 1_000,
    });

    await expect(coordinator.check()).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).not.toHaveBeenCalled();

    safe = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it("does not reload when the network shell matches the running bundle", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const coordinator = createFrontendUpdateCoordinator({
      canReload: () => true,
      currentEntry: () => "/assets/index-current.js",
      fetchLatestHtml: async () => '<script type="module" src="/assets/index-current.js"></script>',
      reload,
      reloadGraceMs: 0,
    });

    await expect(coordinator.check()).resolves.toBe(false);
    await vi.runAllTimersAsync();
    expect(reload).not.toHaveBeenCalled();
    coordinator.dispose();
  });
});
