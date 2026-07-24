import { describe, expect, it, vi } from "vitest";
import {
  linesForPersistence,
  MAX_PERSISTED_CACHE_CHARS,
  RawSessionCache,
  SessionCacheRegistry,
  mergeIndexedLines,
  truncateIndexedLines,
} from "@/persist/session-cache";

describe("raw line cache", () => {
  it("merges by stable physical index with forward data winning", () => {
    const merged = mergeIndexedLines([{ index: 2, raw: "old" }, { index: 4, raw: "four" }], [{ index: 1, raw: "one" }, { index: 2, raw: "new" }]);
    expect(merged).toEqual([{ index: 1, raw: "one" }, { index: 2, raw: "new" }, { index: 4, raw: "four" }]);
    expect(() => structuredClone(merged)).not.toThrow();
  });
  it("does not let lower priority backfill replace streamed records", () => {
    expect(mergeIndexedLines([{ index: 2, raw: "stream" }], [{ index: 2, raw: "stale" }, { index: 1, raw: "old" }], "backfill"))
      .toEqual([{ index: 1, raw: "old" }, { index: 2, raw: "stream" }]);
  });
  it("can replace an old navigation window without retaining prior backfill", () => {
    const cache = new RawSessionCache("replace-window");
    cache.lines = [{ index: 10, raw: "old hit" }, { index: 900, raw: "tail" }];
    expect(cache.replace([{ index: 300, raw: "new hit" }, { index: 900, raw: "tail" }])).toEqual([
      { index: 300, raw: "new hit" },
      { index: 900, raw: "tail" }
    ]);
  });
  it("truncates using physical line count", () => {
    expect(truncateIndexedLines([{ index: 0, raw: "a" }, { index: 5, raw: "b" }], 5)).toEqual([{ index: 0, raw: "a" }]);
  });
  it("bounds persisted history while retaining the newest physical indexes", () => {
    const huge = "x".repeat(MAX_PERSISTED_CACHE_CHARS);
    expect(linesForPersistence([{ index: 1, raw: "old" }, { index: 2, raw: huge }, { index: 3, raw: "latest" }]).map(line => line.index)).toEqual([3]);
  });

  it("evicts the least-recently-used resident session cache", async () => {
    const registry = new SessionCacheRegistry(2);
    const first = registry.get("first");
    registry.get("second");
    expect(registry.get("first")).toBe(first);
    registry.get("third");

    expect(registry.residentCount()).toBe(2);
    expect(registry.has("first")).toBe(true);
    expect(registry.has("second")).toBe(false);
    expect(registry.has("third")).toBe(true);
    await Promise.resolve();
  });

  it("flushes a released cache before disposing its resident lines", async () => {
    const registry = new SessionCacheRegistry(2);
    const cache = registry.get("released");
    cache.lines = [{ index: 1, raw: "resident" }];
    const flush = vi.spyOn(cache, "flush").mockResolvedValue();
    await registry.release("released");
    expect(flush).toHaveBeenCalledOnce();
    expect(registry.has("released")).toBe(false);
    expect(cache.lines).toEqual([]);
  });

  it("computes the next physical index without spreading a large array", () => {
    const cache = new RawSessionCache("large");
    cache.lines = Array.from({ length: 150_000 }, (_, index) => ({ index, raw: "" }));
    expect(cache.nextLineIndex).toBe(150_000);
  });
});
