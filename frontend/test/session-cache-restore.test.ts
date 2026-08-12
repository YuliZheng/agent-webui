import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const state = vi.hoisted(() => ({
  loads: 0,
  resolve: undefined as ((value: any) => void) | undefined,
}));

vi.mock("../src/persist/idb.js", () => ({
  loadSessionCache: vi.fn(() => {
    state.loads++;
    return new Promise((resolve) => { state.resolve = resolve; });
  }),
  saveSessionCache: vi.fn(async () => undefined),
}));

import { useSessionCacheStore } from "../src/stores/session-cache.js";

describe("session cache restore coordination", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    state.loads = 0;
    state.resolve = undefined;
  });

  it("reads IDB once when restore is requested twice", async () => {
    const cache = useSessionCacheStore();
    const a = cache.restore("once");
    const b = cache.restore("once");
    expect(state.loads).toBe(1);
    state.resolve?.({ id: "once", lines: ["old"], nextLineIndex: 1, loadedFromIndex: 0 });
    await Promise.all([a, b]);
    expect(cache.bySession.once?.lines).toEqual(["old"]);
  });

  it("merges live append that arrives while restore is waiting", async () => {
    const cache = useSessionCacheStore();
    const pending = cache.restore("merge");
    cache.appendLine("merge", 2, "live-tail");
    state.resolve?.({ id: "merge", lines: ["old-0", "old-1"], nextLineIndex: 2, loadedFromIndex: 0 });
    await pending;
    expect(cache.bySession.merge?.lines).toEqual(["old-0", "old-1", "live-tail"]);
  });

  it("does not resurrect an IDB snapshot after authoritative replace", async () => {
    const cache = useSessionCacheStore();
    const pending = cache.restore("replace");
    cache.replaceBatch("replace", [{ index: 0, raw: "new" }]);
    state.resolve?.({ id: "replace", lines: ["old"], nextLineIndex: 1, loadedFromIndex: 0 });
    await pending;
    expect(cache.bySession.replace?.lines).toEqual(["new"]);
  });

  it("advances coverage for an empty filtered range", () => {
    const cache = useSessionCacheStore();
    cache.markLoadedFrom("filtered", 40);
    expect(cache.bySession.filtered?.loadedFromIndex).toBe(40);
  });
});
