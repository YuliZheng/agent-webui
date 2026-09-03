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

  it("atomically replaces the old snapshot with a shorter reset replay", async () => {
    const cache = useSessionCacheStore();
    cache.appendBatch("rewrite-a", [
      { index: 0, raw: "old-zero" },
      { index: 1, raw: "old-one" },
    ]);

    cache.replaceBatch("rewrite-a", [
      { index: 0, raw: "new-zero" },
    ]);

    expect(cache.bySession["rewrite-a"]?.lines).toEqual(["new-zero"]);
    expect(cache.bySession["rewrite-a"]?.nextLineIndex).toBe(1);
    await cache.clear("rewrite-a");
  });

  it("replaces an oversized-record placeholder when a larger backend replays the exact line", async () => {
    const cache = useSessionCacheStore();
    cache.appendBatch("images-a", [{
      index: 4,
      raw: JSON.stringify({ type: "agent-webui-record-omitted", bytes: 4_500_000 }),
    }]);
    cache.appendBatch("images-a", [{ index: 4, raw: JSON.stringify({ type: "response_item", payload: { type: "message" } }) }]);

    expect(cache.bySession["images-a"]?.lines[4]).toContain('"type":"response_item"');
    await cache.clear("images-a");
  });

  it("does not invalidate transcript content for an identical replay batch", async () => {
    const cache = useSessionCacheStore();
    const item = { index: 0, raw: '{"type":"user"}' };
    cache.appendBatch("duplicate-tail", [item]);
    const entry = cache.bySession["duplicate-tail"]!;
    const lines = entry.lines;
    const contentRevision = entry.contentRevision;
    const revision = entry.revision;

    cache.appendBatch("duplicate-tail", [item]);

    expect(entry.lines).toBe(lines);
    expect(entry.contentRevision).toBe(contentRevision);
    expect(entry.revision).toBe(revision);
    await cache.clear("duplicate-tail");
  });
});
