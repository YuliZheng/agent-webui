import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const socket = vi.hoisted(() => ({
  addEventListener: vi.fn(),
  connect: vi.fn(),
  request: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  updateGlobalNotifSinceSeq: vi.fn(),
  updateSessionFrom: vi.fn(),
}));

vi.mock("@/api/ws", () => ({ mainSocket: socket }));

import { sessionCaches } from "@/persist/session-cache";
import {
  EARLIER_SESSION_PAGE_LINES,
  INITIAL_SESSION_TAIL_LINES,
  PREFETCH_MAX_SESSION_BYTES,
  PREFETCH_SESSION_LIMIT,
  useLiveStore,
} from "@/stores/live";
import { useSessionsStore } from "@/stores/sessions";

describe("live transcript residency", () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    socket.request.mockResolvedValue([]);
    await sessionCaches.release("a");
    await sessionCaches.release("b");
    await sessionCaches.release("prefetched");
  });

  it("subscribes to only the initial 200-line tail, then pages upward by 200", async () => {
    const sessions = useSessionsStore();
    sessions.items = [
      { id: "a", agent: "claude", cwd: "C:\\a", mtime: new Date().toISOString(), size: 1000 },
    ];
    const live = useLiveStore();
    await live.open("a");
    expect(socket.subscribe).toHaveBeenCalledWith({
      channel: "session",
      sessionId: "a",
      from: 0,
      tailN: INITIAL_SESSION_TAIL_LINES,
    });

    live.onPush({
      type: "stream-batch",
      kind: "stream-batch",
      sessionId: "a",
      lines: Array.from({ length: 200 }, (_, offset) => ({ index: 400 + offset, raw: `line-${offset}` })),
    });
    socket.request.mockResolvedValueOnce([]);
    await live.loadEarlier("a");
    expect(socket.request).toHaveBeenLastCalledWith("read-range", {
      sessionId: "a",
      from: 200,
      to: 400,
    });
    expect(EARLIER_SESSION_PAGE_LINES).toBe(200);
  });

  it("keeps only one bounded search neighborhood plus the live tail", async () => {
    const sessions = useSessionsStore();
    sessions.items = [
      { id: "a", agent: "claude", cwd: "C:\\a", mtime: new Date().toISOString(), size: 1000 },
    ];
    const live = useLiveStore();
    await live.open("a");
    live.onPush({
      type: "stream-batch",
      kind: "stream-batch",
      sessionId: "a",
      lines: Array.from({ length: INITIAL_SESSION_TAIL_LINES }, (_, offset) => ({
        index: 800 + offset,
        data: `tail-${offset}`
      })),
    });
    socket.request
      .mockResolvedValueOnce([{ index: 100, raw: "first hit" }])
      .mockResolvedValueOnce([{ index: 500, raw: "second hit" }]);

    await live.loadAround("a", 100);
    expect(socket.request).toHaveBeenLastCalledWith("read-range", {
      sessionId: "a",
      from: 0,
      to: 221,
    });
    expect(live.linesBySession.a?.some((line) => line.index === 100)).toBe(true);

    await live.loadAround("a", 500);
    expect(socket.request).toHaveBeenLastCalledWith("read-range", {
      sessionId: "a",
      from: 380,
      to: 621,
    });
    expect(live.linesBySession.a?.some((line) => line.index === 100)).toBe(false);
    expect(live.linesBySession.a?.some((line) => line.index === 500)).toBe(true);
    expect(live.linesBySession.a?.filter((line) => line.index >= 800)).toHaveLength(INITIAL_SESSION_TAIL_LINES);
    expect(live.linesBySession.a?.length).toBeLessThanOrEqual(INITIAL_SESSION_TAIL_LINES + 241);
  });

  it("unsubscribes and releases the previous transcript without deleting global status", async () => {
    const sessions = useSessionsStore();
    sessions.items = [
      { id: "a", agent: "claude", cwd: "C:\\a", mtime: new Date().toISOString(), size: 1000 },
      { id: "b", agent: "codex", cwd: "C:\\b", mtime: new Date().toISOString(), size: 1000 },
    ];
    const live = useLiveStore();
    await live.open("a");
    live.onPush({ type: "stream-line", kind: "stream-line", sessionId: "a", index: 0, data: "a" });
    live.onPush({ type: "session-status", kind: "session-status", sessionId: "a", status: "running", webuiAlive: true });
    expect(live.linesBySession.a).toHaveLength(1);

    await live.open("b");
    expect(socket.unsubscribe).toHaveBeenCalledWith({ channel: "session", sessionId: "a" });
    expect(live.linesBySession.a).toBeUndefined();
    expect(sessionCaches.has("a")).toBe(false);
    expect(sessions.statuses.a).toMatchObject({ status: "running", webuiAlive: true });

    live.onPush({ type: "stream-line", kind: "stream-line", sessionId: "a", index: 1, data: "late" });
    expect(live.linesBySession.a).toBeUndefined();
  });

  it("does not leave non-selected prefetch caches resident", async () => {
    const sessions = useSessionsStore();
    const live = useLiveStore();
    socket.request.mockResolvedValueOnce([{ index: 1, raw: "tail" }]);
    await live.prefetch([
      { id: "prefetched", agent: "claude", cwd: "C:\\p", mtime: new Date().toISOString(), size: 1000 },
    ]);
    expect(sessionCaches.has("prefetched")).toBe(false);
    expect(sessions.selectedId).toBeNull();
  });

  it("serializes optional prefetch and skips large transcripts", async () => {
    const sessions = useSessionsStore();
    const live = useLiveStore();
    let resolveFirst!: (lines: Array<{ index: number; raw: string }>) => void;
    const first = new Promise<Array<{ index: number; raw: string }>>(resolve => { resolveFirst = resolve; });
    socket.request
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce([{ index: 2, raw: "second" }]);
    const loading = live.prefetch([
      { id: "a", agent: "claude", cwd: "C:\\a", mtime: new Date().toISOString(), size: 1000 },
      { id: "b", agent: "claude", cwd: "C:\\b", mtime: new Date().toISOString(), size: 1000 },
      { id: "too-large", agent: "claude", cwd: "C:\\large", mtime: new Date().toISOString(), size: PREFETCH_MAX_SESSION_BYTES + 1 },
    ]);
    await Promise.resolve();
    expect(socket.request).toHaveBeenCalledTimes(1);
    resolveFirst([{ index: 1, raw: "first" }]);
    await loading;
    expect(socket.request).toHaveBeenCalledTimes(PREFETCH_SESSION_LIMIT);
    expect(socket.request.mock.calls.map(call => call[1])).toEqual([
      { sessionId: "a", n: 200 },
      { sessionId: "b", n: 200 },
    ]);
    expect(sessionCaches.has("a")).toBe(false);
    expect(sessionCaches.has("b")).toBe(false);
    expect(sessionCaches.has("too-large")).toBe(false);
    expect(sessions.selectedId).toBeNull();
  });

  it("does not resurrect an old transcript when backfill finishes after a switch", async () => {
    let finishBackfill!: (lines: Array<{ index: number; raw: string }>) => void;
    const backfill = new Promise<Array<{ index: number; raw: string }>>(resolve => { finishBackfill = resolve; });
    const sessions = useSessionsStore();
    sessions.items = [
      { id: "a", agent: "claude", cwd: "C:\\a", mtime: new Date().toISOString(), size: 1000 },
      { id: "b", agent: "codex", cwd: "C:\\b", mtime: new Date().toISOString(), size: 1000 },
    ];
    const live = useLiveStore();
    await live.open("a");
    live.onPush({ type: "stream-line", kind: "stream-line", sessionId: "a", index: 400, data: "current" });
    socket.request.mockReturnValueOnce(backfill);
    const loading = live.loadEarlier("a");
    await live.open("b");
    finishBackfill([{ index: 200, raw: "late backfill" }]);
    await loading;
    expect(live.linesBySession.a).toBeUndefined();
    expect(sessionCaches.has("a")).toBe(false);
  });

  it("releases the active transcript when selection is cleared externally", async () => {
    const sessions = useSessionsStore();
    sessions.items = [
      { id: "a", agent: "claude", cwd: "C:\\a", mtime: new Date().toISOString(), size: 1000 },
    ];
    const live = useLiveStore();
    await live.open("a");
    sessions.handoffSelection(null);
    await Promise.resolve();
    expect(socket.unsubscribe).toHaveBeenCalledWith({ channel: "session", sessionId: "a" });
    expect(live.linesBySession.a).toBeUndefined();
    expect(sessionCaches.has("a")).toBe(false);
  });
});
