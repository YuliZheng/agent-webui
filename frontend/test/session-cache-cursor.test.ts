import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSessionCacheStore } from "../src/stores/session-cache.js";

describe("session cache physical cursor", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("advances past filtered physical lines without allocating placeholder rows", async () => {
    const cache = useSessionCacheStore();
    cache.appendBatch("cursor-a", [{ index: 4, raw: "{\"type\":\"user\"}" }]);
    cache.advanceCursor("cursor-a", 12);

    expect(cache.bySession["cursor-a"]?.nextLineIndex).toBe(12);
    expect(cache.bySession["cursor-a"]?.lines).toHaveLength(5);
    await cache.clear("cursor-a");
  });

  it("takes stream-truncate as exact ground truth in both directions", async () => {
    const cache = useSessionCacheStore();
    cache.appendBatch("cursor-b", [{ index: 2, raw: "{\"type\":\"user\"}" }]);
    cache.advanceCursor("cursor-b", 8);

    cache.truncateTo("cursor-b", 5);
    expect(cache.bySession["cursor-b"]?.nextLineIndex).toBe(5);

    cache.truncateTo("cursor-b", 11);
    expect(cache.bySession["cursor-b"]?.nextLineIndex).toBe(11);
    expect(cache.bySession["cursor-b"]?.lines).toHaveLength(3);
    await cache.clear("cursor-b");
  });

  it("accepts a shorter reset replay that replaces the old first slot", async () => {
    const cache = useSessionCacheStore();
    cache.appendBatch("rewrite-a", [
      { index: 0, raw: "old-zero" },
      { index: 1, raw: "old-one" },
    ]);

    // live.ts handles stream-reset by starting clear() without awaiting it;
    // the in-memory deletion is synchronous, so the following replay must
    // populate fresh slots rather than merge against the old rows.
    const clearing = cache.clear("rewrite-a");
    cache.appendBatch("rewrite-a", [
      { index: 0, raw: "new-zero" },
    ]);

    expect(cache.bySession["rewrite-a"]?.lines).toEqual(["new-zero"]);
    expect(cache.bySession["rewrite-a"]?.nextLineIndex).toBe(1);
    await clearing;
    await cache.clear("rewrite-a");
  });
});
