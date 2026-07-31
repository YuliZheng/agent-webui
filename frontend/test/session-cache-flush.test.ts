import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

interface Snapshot {
  id: string;
  lines: string[];
  nextLineIndex: number;
}

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
}

const storage = vi.hoisted(() => ({
  saves: [] as Snapshot[],
  gates: [] as Gate[],
}));

vi.mock("../src/persist/idb.js", () => ({
  loadSessionCache: vi.fn(async () => undefined),
  saveSessionCache: vi.fn((value: Snapshot) => {
    storage.saves.push(structuredClone(value));
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    storage.gates.push({ promise, resolve });
    return promise;
  }),
}));

import { useSessionCacheStore } from "../src/stores/session-cache.js";

async function drainMicrotasks(): Promise<void> {
  // The production path has two serialized promise-finally layers (the IDB
  // tail and the single flush worker). Drain enough turns for a resolved gate
  // to start the next queued snapshot without advancing the 200 ms debounce.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("session cache flush serialization", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    storage.saves.length = 0;
    storage.gates.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("persists an append that lands while an older snapshot is being saved", async () => {
    const cache = useSessionCacheStore();
    cache.appendLine("append-race", 0, "first");
    const flushing = cache.flush("append-race");
    await drainMicrotasks();

    expect(storage.saves).toEqual([{
      id: "append-race",
      lines: ["first"],
      nextLineIndex: 1,
    }]);

    cache.appendLine("append-race", 1, "second");
    const joinedFlush = cache.flush("append-race");
    storage.gates[0]!.resolve();
    await drainMicrotasks();

    expect(storage.saves).toEqual([
      { id: "append-race", lines: ["first"], nextLineIndex: 1 },
      { id: "append-race", lines: ["first", "second"], nextLineIndex: 2 },
    ]);

    storage.gates[1]!.resolve();
    await Promise.all([flushing, joinedFlush]);
    expect(cache.bySession["append-race"]?.dirty).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(storage.saves).toHaveLength(2);
  });

  it("queues clear after an in-flight snapshot so stale data cannot be restored", async () => {
    const cache = useSessionCacheStore();
    cache.appendLine("clear-race", 0, "stale");
    const flushing = cache.flush("clear-race");
    await drainMicrotasks();

    const clearing = cache.clear("clear-race");
    await drainMicrotasks();
    expect(storage.saves).toHaveLength(1);

    storage.gates[0]!.resolve();
    await drainMicrotasks();
    expect(storage.saves).toEqual([
      { id: "clear-race", lines: ["stale"], nextLineIndex: 1 },
      { id: "clear-race", lines: [], nextLineIndex: 0 },
    ]);

    storage.gates[1]!.resolve();
    await Promise.all([flushing, clearing]);
    expect(cache.bySession["clear-race"]).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(storage.saves).toHaveLength(2);
  });

  it("orders old flush, clear, and a recreated entry without stale resurrection", async () => {
    const cache = useSessionCacheStore();
    cache.appendLine("recreate-race", 0, "old");
    const oldFlush = cache.flush("recreate-race");
    await drainMicrotasks();

    const clearing = cache.clear("recreate-race");
    cache.appendLine("recreate-race", 0, "new");
    // Let the recreated entry's debounce join the old single writer while its
    // first snapshot is still blocked.
    await vi.advanceTimersByTimeAsync(200);
    expect(storage.saves).toEqual([
      { id: "recreate-race", lines: ["old"], nextLineIndex: 1 },
    ]);

    storage.gates[0]!.resolve();
    await drainMicrotasks();
    expect(storage.saves).toEqual([
      { id: "recreate-race", lines: ["old"], nextLineIndex: 1 },
      { id: "recreate-race", lines: [], nextLineIndex: 0 },
    ]);

    storage.gates[1]!.resolve();
    await drainMicrotasks();
    expect(storage.saves).toEqual([
      { id: "recreate-race", lines: ["old"], nextLineIndex: 1 },
      { id: "recreate-race", lines: [], nextLineIndex: 0 },
      { id: "recreate-race", lines: ["new"], nextLineIndex: 1 },
    ]);

    storage.gates[2]!.resolve();
    await Promise.all([oldFlush, clearing]);
    await drainMicrotasks();
    expect(cache.bySession["recreate-race"]?.dirty).toBe(false);
    expect(cache.bySession["recreate-race"]?.lines).toEqual(["new"]);
  });
});
