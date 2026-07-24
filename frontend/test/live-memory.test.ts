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
const httpApi = vi.hoisted(() => vi.fn());

vi.mock("@/api/ws", () => ({ mainSocket: socket }));
vi.mock("@/api/http", () => ({ api: httpApi }));

import { sessionCaches } from "@/persist/session-cache";
import {
  EARLIER_SESSION_PAGE_LINES,
  ENGAGE_HTTP_TAIL_LINES,
  INITIAL_SESSION_TAIL_LINES,
  PREFETCH_SESSION_LIMIT,
  STALE_STREAM_MS,
  useLiveStore,
} from "@/stores/live";
import { useSessionsStore } from "@/stores/sessions";

describe("live transcript residency", () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    socket.request.mockResolvedValue([]);
    httpApi.mockResolvedValue([]);
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
    expect(httpApi).toHaveBeenCalledWith(
      `/api/sessions/a/tail?n=${ENGAGE_HTTP_TAIL_LINES}`,
    );
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
    httpApi.mockResolvedValueOnce([{ index: 1, raw: "tail" }]);
    await live.prefetch([
      { id: "prefetched", agent: "claude", cwd: "C:\\p", mtime: new Date().toISOString(), size: 1000 },
    ]);
    expect(sessionCaches.has("prefetched")).toBe(false);
    expect(sessions.selectedId).toBeNull();
  });

  it("serializes HTTP prefetch and limits it to the eight most recent sessions", async () => {
    const sessions = useSessionsStore();
    const live = useLiveStore();
    let resolveFirst!: (lines: Array<{ index: number; raw: string }>) => void;
    const first = new Promise<Array<{ index: number; raw: string }>>(resolve => { resolveFirst = resolve; });
    httpApi
      .mockReturnValueOnce(first)
      .mockResolvedValue([{ index: 2, raw: "next" }]);
    const items = Array.from({ length: PREFETCH_SESSION_LIMIT + 1 }, (_, index) => ({
      id: `prefetch-${index}`,
      agent: "claude" as const,
      cwd: `C:\\p${index}`,
      mtime: new Date().toISOString(),
      size: 1000,
    }));
    const loading = live.prefetch(items);
    await Promise.resolve();
    expect(httpApi).toHaveBeenCalledTimes(1);
    resolveFirst([{ index: 1, raw: "first" }]);
    await loading;
    expect(httpApi).toHaveBeenCalledTimes(PREFETCH_SESSION_LIMIT);
    expect(httpApi.mock.calls.map(call => call[0])).toEqual(
      items.slice(0, PREFETCH_SESSION_LIMIT).map(
        item => `/api/sessions/${item.id}/tail?n=200`,
      ),
    );
    for (const item of items) expect(sessionCaches.has(item.id)).toBe(false);
    expect(sessions.selectedId).toBeNull();
  });

  it("resubscribes an engaged session when touched data does not reach the stream", async () => {
    vi.useFakeTimers();
    try {
      const sessions = useSessionsStore();
      sessions.items = [
        { id: "a", agent: "claude", cwd: "C:\\a", mtime: new Date().toISOString(), size: 1000 },
      ];
      const live = useLiveStore();
      await live.open("a");
      socket.subscribe.mockClear();

      live.onPush({ type: "session-touched", kind: "session-touched", id: "a" });
      await vi.advanceTimersByTimeAsync(STALE_STREAM_MS - 1);
      expect(socket.subscribe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.subscribe).toHaveBeenCalledWith({
        channel: "session",
        sessionId: "a",
        from: 0,
      });

      socket.subscribe.mockClear();
      live.onPush({ type: "session-touched", kind: "session-touched", id: "a" });
      live.onPush({ type: "stream-line", kind: "stream-line", sessionId: "a", index: 0, data: "arrived" });
      await vi.advanceTimersByTimeAsync(STALE_STREAM_MS);
      expect(socket.subscribe).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
