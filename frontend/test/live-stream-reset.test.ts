import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const tailApi = vi.hoisted(() => ({ readSessionTail: vi.fn(), readSessionRange: vi.fn() }));

vi.mock("../src/api/sessions.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/api/sessions.js")>(),
  readSessionTail: tailApi.readSessionTail,
  readSessionRange: tailApi.readSessionRange,
}));

import { useLiveStore } from "../src/stores/live.js";
import { useSessionCacheStore } from "../src/stores/session-cache.js";
import { useSessionsStore } from "../src/stores/sessions.js";
import { usePromptPendingStore } from "../src/stores/prompt-pending.js";
import { useUiStore } from "../src/stores/ui.js";

describe("live stream reset handoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    tailApi.readSessionTail.mockReset();
    tailApi.readSessionRange.mockReset();
    tailApi.readSessionTail.mockResolvedValue({ totalLines: 0, fromIndex: 0, lines: [] });
  });
  afterEach(() => vi.useRealTimers());

  it("repairs preview and running status from a durable Codex tail", () => {
    const id = "durable-terminal-repair";
    const sessions = useSessionsStore();
    const live = useLiveStore();
    sessions.addOrTouch({
      id,
      cwd: "C:\\repo",
      mtime: "2026-08-29T18:24:58.000Z",
      size: 1,
      agent: "codex",
      preview: "stale prompt",
      previewRole: "user",
    });
    sessions.setStatus(id, "running", true, true);
    live.turnProgress[id] = "stale tool";
    const pending = usePromptPendingStore();
    pending.add(id, {
      text: "the completed prompt",
      imageCount: 0,
      startedAtLineCount: 10,
      startedAtSessionSize: 1,
      agent: "codex",
      phase: "dispatched",
    });

    live.observeTurnProgressLine(id, JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-29T18:25:09.186Z",
      payload: { type: "agent_message", message: "Latest durable answer" },
    }));
    expect(sessions.byId[id]?.preview).toBe("Latest durable answer");
    expect(sessions.byId[id]?.previewRole).toBe("assistant");
    expect(sessions.statusBySession[id]).toBe("running");

    live.observeTurnProgressLine(id, JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-29T18:25:10.339Z",
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: "Latest durable answer",
      },
    }), 20);
    expect(sessions.statusBySession[id]).toBe("exited");
    expect(sessions.compactingBySession[id]).toBeUndefined();
    expect(sessions.byId[id]?.lastBoundaryAt).toBe("2026-08-29T18:25:10.339Z");
    expect(live.turnProgress[id]).toBeUndefined();
    expect(pending.pending(id)[0]?.phase).toBe("accepted");
  });

  it("uses a durable user message as the current turn boundary", () => {
    const id = "durable-turn-boundary";
    const sessions = useSessionsStore();
    const live = useLiveStore();
    sessions.addOrTouch({
      id,
      cwd: "C:\\repo",
      mtime: "2026-08-29T10:00:00.000Z",
      size: 1,
      agent: "codex",
      lastBoundaryAt: "2026-08-29T10:00:00.000Z",
    });
    sessions.setStatus(id, "running", true, true);

    live.observeTurnProgressLine(id, JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-29T18:25:09.186Z",
      payload: { type: "user_message", message: "Continue the current turn" },
    }));

    expect(sessions.byId[id]?.lastBoundaryAt).toBe("2026-08-29T18:25:09.186Z");
    expect(sessions.byId[id]?.lastTurnAt).toBe("2026-08-29T18:25:09.186Z");
    expect(sessions.statusBySession[id]).toBe("running");
    expect(sessions.compactingBySession[id]).toBeUndefined();
  });

  it("clears stale compaction from a durable completion while keeping the turn running", () => {
    const id = "durable-compaction-complete";
    const sessions = useSessionsStore();
    const live = useLiveStore();
    sessions.addOrTouch({
      id,
      cwd: "C:\\repo",
      mtime: "2026-08-29T18:24:58.000Z",
      size: 1,
      agent: "codex",
    });
    sessions.setStatus(id, "running", true, true);
    live.turnProgress[id] = "Codex is working…";

    live.observeTurnProgressLine(id, JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-29T18:25:09.186Z",
      payload: { type: "context_compacted" },
    }));

    expect(sessions.statusBySession[id]).toBe("running");
    expect(sessions.webuiAliveBySession[id]).toBe(true);
    expect(sessions.compactingBySession[id]).toBeUndefined();
    expect(live.turnProgress[id]).toBe("Codex is working…");
  });

  it("returns to a running label after a tool completes instead of sticking on Completed", () => {
    const live = useLiveStore();
    const id = "tool-complete-progress";

    live.observeTurnProgressLine(id, JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "call-1",
        name: "exec",
        input: "check status",
      },
    }));
    expect(live.turnProgress[id]).toContain("exec");

    live.observeTurnProgressLine(id, JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call-1",
        output: "done",
      },
    }));

    expect(live.turnProgress[id]).toBe("Codex is working…");
    expect(live.turnProgress[id]).not.toContain("Completed");
  });

  it("keeps the rendered snapshot until the authoritative replay can replace it atomically", async () => {
    const cache = useSessionCacheStore();
    const live = useLiveStore();
    cache.appendBatch("codex-a", [
      { index: 0, raw: "old-user" },
      { index: 1, raw: "old-assistant" },
    ]);

    live.onSessionMsg("codex-a", { type: "stream-reset" });
    expect(cache.bySession["codex-a"]?.lines).toEqual(["old-user", "old-assistant"]);

    // The first replay batch can contain only bookkeeping that produces no
    // visible timeline nodes. Keep the old render while later batches arrive.
    live.onSessionMsg("codex-a", {
      type: "stream-batch",
      lines: [{ index: 0, data: "new-bookkeeping" }],
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(cache.bySession["codex-a"]?.lines).toEqual(["old-user", "old-assistant"]);

    live.onSessionMsg("codex-a", {
      type: "stream-batch",
      lines: [{ index: 1, data: "new-user" }],
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(cache.bySession["codex-a"]?.lines).toEqual(["old-user", "old-assistant"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(cache.bySession["codex-a"]?.lines).toEqual(["new-bookkeeping", "new-user"]);
    expect(cache.bySession["codex-a"]?.nextLineIndex).toBe(2);

    live.closeAll();
    vi.useRealTimers();
    await cache.clear("codex-a");
  });

  it("keeps the last good snapshot when a mobile reset replay stalls", async () => {
    const cache = useSessionCacheStore();
    const live = useLiveStore();
    cache.appendBatch("codex-stalled", [
      { index: 0, raw: "cached-user" },
      { index: 1, raw: "cached-assistant" },
    ]);

    live.onSessionMsg("codex-stalled", { type: "stream-reset" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(cache.bySession["codex-stalled"]?.lines).toEqual([
      "cached-user",
      "cached-assistant",
    ]);

    live.closeAll();
    vi.useRealTimers();
    await cache.clear("codex-stalled");
  });

  it("merges the first bounded replay but replaces a later rewrite on the same subscription", async () => {
    const cache = useSessionCacheStore();
    const live = useLiveStore();
    cache.appendBatch("cached-prefix", [
      { index: 0, raw: "cached-zero" },
      { index: 1, raw: "shared-one" },
    ]);
    const generation = live.subscribeToSession("cached-prefix", 0, 200);

    live.onSessionMsg("cached-prefix", { type: "stream-reset" }, generation);
    live.onSessionMsg("cached-prefix", {
      type: "stream-batch",
      lines: [
        { index: 1, data: "shared-one" },
        { index: 2, data: "fresh-two" },
      ],
    }, generation);
    await vi.advanceTimersByTimeAsync(250);
    expect(cache.bySession["cached-prefix"]?.lines).toEqual([
      "cached-zero",
      "shared-one",
      "fresh-two",
    ]);

    live.onSessionMsg("cached-prefix", { type: "stream-reset" }, generation);
    live.onSessionMsg("cached-prefix", {
      type: "stream-batch",
      lines: [{ index: 0, data: "rewritten-zero" }],
    }, generation);
    await vi.advanceTimersByTimeAsync(250);
    expect(cache.bySession["cached-prefix"]?.lines).toEqual(["rewritten-zero"]);

    live.closeAll();
    vi.useRealTimers();
    await cache.clear("cached-prefix");
  });

  it("drops a callback from a superseded local subscription generation", async () => {
    const cache = useSessionCacheStore();
    const live = useLiveStore();
    const oldGeneration = live.subscribeToSession("generation-a", 0, 200);
    live.disengage("generation-a");
    const currentGeneration = live.subscribeToSession("generation-a", 0, 200);

    live.onSessionMsg("generation-a", {
      type: "stream-line",
      index: 0,
      data: "stale",
    }, oldGeneration);
    live.onSessionMsg("generation-a", {
      type: "stream-line",
      index: 0,
      data: "current",
    }, currentGeneration);

    expect(cache.bySession["generation-a"]?.lines).toEqual(["current"]);
    live.closeAll();
    vi.useRealTimers();
    await cache.clear("generation-a");
  });

  it("upgrades an omitted cached record during initial replay without dropping its prefix", async () => {
    const cache = useSessionCacheStore();
    const live = useLiveStore();
    cache.appendBatch("omitted-upgrade", [
      { index: 0, raw: "cached-prefix" },
      { index: 1, raw: JSON.stringify({ type: "agent-webui-record-omitted", bytes: 20_000_000 }) },
    ]);
    const generation = live.subscribeToSession("omitted-upgrade", 0, 200);

    live.onSessionMsg("omitted-upgrade", { type: "stream-reset" }, generation);
    live.onSessionMsg("omitted-upgrade", {
      type: "stream-batch",
      lines: [{ index: 1, data: JSON.stringify({ type: "assistant", message: { content: "exact" } }) }],
    }, generation);
    await vi.advanceTimersByTimeAsync(250);

    expect(cache.bySession["omitted-upgrade"]?.lines[0]).toBe("cached-prefix");
    expect(cache.bySession["omitted-upgrade"]?.lines[1]).toContain('"type":"assistant"');
    live.closeAll();
    vi.useRealTimers();
    await cache.clear("omitted-upgrade");
  });

  it("coalesces tail requests, reuses a fresh result, and lets force bypass freshness", async () => {
    const live = useLiveStore();
    let resolveFirst!: (value: { totalLines: number; fromIndex: number; lines: never[] }) => void;
    tailApi.readSessionTail.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));

    const first = live.refreshSession("http-coalesce");
    const joined = live.refreshSession("http-coalesce");
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(1);
    expect(live.tailFetching["http-coalesce"]).toBe(true);

    resolveFirst({ totalLines: 0, fromIndex: 0, lines: [] });
    await Promise.all([first, joined]);
    expect(live.tailFetching["http-coalesce"]).toBe(false);
    expect(useSessionCacheStore().bySession["http-coalesce"]?.loadedFromIndex).toBe(0);

    await live.refreshSession("http-coalesce");
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(1);

    tailApi.readSessionTail.mockResolvedValueOnce({ totalLines: 0, fromIndex: 0, lines: [] });
    await live.refreshSession("http-coalesce", true);
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(2);
  });

  it("lets a foreground force-refresh supersede a stale interactive tail request", async () => {
    const live = useLiveStore();
    const cache = useSessionCacheStore();
    let resolveStale!: (value: { totalLines: number; fromIndex: number; lines: Array<{ index: number; raw: string }> }) => void;
    tailApi.readSessionTail.mockReturnValueOnce(new Promise((resolve) => { resolveStale = resolve; }));

    const stale = live.refreshSession("mobile-stale-tail");
    await vi.advanceTimersByTimeAsync(2_001);
    tailApi.readSessionTail.mockResolvedValueOnce({
      totalLines: 13_733,
      fromIndex: 13_731,
      lines: [
        { index: 13_731, raw: "tool-after-stale-boundary" },
        { index: 13_732, raw: "latest-table-reply" },
      ],
    });

    await live.refreshSession("mobile-stale-tail", true);
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(2);
    expect(cache.bySession["mobile-stale-tail"]?.nextLineIndex).toBe(13_733);
    expect(cache.bySession["mobile-stale-tail"]?.lines[13_732]).toBe("latest-table-reply");
    expect(live.tailFetching["mobile-stale-tail"]).toBe(false);

    // A late response from the superseded request must not roll the cache back.
    resolveStale({ totalLines: 13_674, fromIndex: 13_673, lines: [{ index: 13_673, raw: "old-tail" }] });
    await stale;
    expect(cache.bySession["mobile-stale-tail"]?.nextLineIndex).toBe(13_733);
    expect(cache.bySession["mobile-stale-tail"]?.lines[13_732]).toBe("latest-table-reply");
  });

  it("caps watchdog HTTP traffic when filtered writes keep touching a session", async () => {
    const live = useLiveStore();
    live.perSession["watchdog-cooldown"] = () => undefined;
    const touched = { kind: "session-touched", id: "watchdog-cooldown" };

    live.onGlobal(touched);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(1);

    live.onGlobal(touched);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(12_000);
    live.onGlobal(touched);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(2);
    live.closeAll();
  });

  it("does not let stream control frames cancel a pending transcript watchdog", async () => {
    const live = useLiveStore();
    live.perSession["watchdog-control"] = () => undefined;

    live.onGlobal({ kind: "session-touched", id: "watchdog-control" });
    live.onSessionMsg("watchdog-control", { type: "stream-reset" });
    live.onSessionMsg("watchdog-control", { type: "stream-cursor", nextIndex: 12 });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(1);
    live.closeAll();
  });

  it("repairs the viewed transcript when an assistant preview arrives first", async () => {
    const id = "preview-ahead-of-transcript";
    const live = useLiveStore();
    const cache = useSessionCacheStore();
    const sessions = useSessionsStore();
    sessions.addOrTouch({
      id,
      cwd: "C:\\repo",
      mtime: "2026-08-23T12:16:43.700Z",
      size: 1,
      agent: "codex",
      preview: "user question",
      previewRole: "user",
      lastTurnAt: "2026-08-23T12:16:43.700Z",
    });
    useUiStore().selectFromHistory(id);
    live.perSession[id] = () => undefined;
    tailApi.readSessionTail.mockResolvedValueOnce({
      totalLines: 2,
      fromIndex: 0,
      lines: [
        { index: 0, raw: "user-line" },
        { index: 1, raw: "assistant-line" },
      ],
    });

    live.onGlobal({
      kind: "session-touched",
      id,
      mtime: "2026-08-23T12:17:05.239Z",
      size: 2,
      preview: "assistant answer",
      previewRole: "assistant",
      lastTurnAt: "2026-08-23T12:17:05.239Z",
    });
    // These frames previously cancelled the only recovery path.
    live.onSessionMsg(id, { type: "stream-reset" });
    live.onSessionMsg(id, { type: "stream-cursor", nextIndex: 1 });

    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(1);
    expect(cache.bySession[id]?.lines[1]).toBe("assistant-line");
    live.closeAll();
    vi.useRealTimers();
    await cache.clear(id);
  });

  it("runs a fresh viewed-completion tail after an older open request settles", async () => {
    const id = "completion-after-stale-open";
    const live = useLiveStore();
    const cache = useSessionCacheStore();
    useSessionsStore().addOrTouch({
      id,
      cwd: "C:\\repo",
      mtime: "2026-08-23T12:16:43.700Z",
      size: 1,
      agent: "codex",
    });
    useUiStore().selectFromHistory(id);
    let resolveOpen!: (value: {
      totalLines: number;
      fromIndex: number;
      lines: Array<{ index: number; raw: string }>;
    }) => void;
    tailApi.readSessionTail
      .mockReturnValueOnce(new Promise((resolve) => { resolveOpen = resolve; }))
      .mockResolvedValueOnce({
        totalLines: 2,
        fromIndex: 0,
        lines: [
          { index: 0, raw: "user-line" },
          { index: 1, raw: "assistant-after-open" },
        ],
      });

    const openFetch = live.refreshSession(id);
    live.onGlobal({
      kind: "notification",
      id,
      body: "assistant after open",
      timestamp: "2026-08-23T12:17:05.239Z",
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(1);

    resolveOpen({ totalLines: 1, fromIndex: 0, lines: [{ index: 0, raw: "user-line" }] });
    await openFetch;
    await Promise.resolve();
    await Promise.resolve();
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(2);
    expect(cache.bySession[id]?.lines[1]).toBe("assistant-after-open");
    live.closeAll();
    vi.useRealTimers();
    await cache.clear(id);
  });

  it("records a tail error, rejects the caller, and clears it after retry", async () => {
    const live = useLiveStore();
    tailApi.readSessionTail.mockRejectedValueOnce(new Error("tail offline"));

    await expect(live.refreshSession("http-error", true)).rejects.toThrow("tail offline");
    expect(live.tailFetching["http-error"]).toBe(false);
    expect(live.tailErrors["http-error"]).toBe("tail offline");

    tailApi.readSessionTail.mockResolvedValueOnce({ totalLines: 0, fromIndex: 0, lines: [] });
    await live.refreshSession("http-error", true);
    expect(live.tailErrors["http-error"]).toBeUndefined();
  });

  it("treats a shorter or conflicting HTTP tail as authoritative", async () => {
    const cache = useSessionCacheStore();
    const live = useLiveStore();
    cache.appendBatch("http-rewrite", [
      { index: 0, raw: "old-zero" },
      { index: 1, raw: "old-one" },
    ]);
    tailApi.readSessionTail.mockResolvedValueOnce({
      totalLines: 1,
      fromIndex: 0,
      lines: [{ index: 0, raw: "new-zero" }],
    });

    await live.refreshSession("http-rewrite", true);
    expect(cache.bySession["http-rewrite"]?.lines).toEqual(["new-zero"]);
    expect(cache.bySession["http-rewrite"]?.nextLineIndex).toBe(1);

    vi.useRealTimers();
    await cache.clear("http-rewrite");
  });

  it("backfills a sparse gap with the compact range after merging the latest HTTP tail", async () => {
    const cache = useSessionCacheStore();
    const live = useLiveStore();
    useSessionsStore().addOrTouch({
      id: "http-gap", cwd: "C:\\repo", mtime: "2026-08-01T00:00:00.000Z",
      size: 1, agent: "codex",
    });
    const user = JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "start" } });
    cache.appendBatch("http-gap", [{ index: 2598, raw: user }]);
    // A previous fixed-tail sync may already have advanced the physical cursor
    // even though it left a sparse hole in the actual cached rows.
    cache.advanceCursor("http-gap", 3192);
    tailApi.readSessionTail.mockResolvedValueOnce({
      totalLines: 3193, fromIndex: 3132,
      lines: [{ index: 3132, raw: "latest" }],
      supportsCompactRange: true,
    });
    tailApi.readSessionRange.mockResolvedValueOnce({
      lines: [{ index: 2599, raw: "bridge-start" }, { index: 3131, raw: "bridge-end" }],
    });

    await live.refreshSession("http-gap", true);
    await Promise.resolve();
    await Promise.resolve();
    expect(tailApi.readSessionRange).toHaveBeenCalledWith(
      "http-gap",
      2599,
      3132,
      expect.objectContaining({ mode: "compact" }),
    );
    expect(cache.bySession["http-gap"]?.lines[2599]).toBe("bridge-start");
    expect(cache.bySession["http-gap"]?.lines[3131]).toBe("bridge-end");
    expect(cache.bySession["http-gap"]?.lines[3132]).toBe("latest");
  });

  it("does not range-fetch when the cached line immediately precedes the tail", async () => {
    const cache = useSessionCacheStore();
    const live = useLiveStore();
    useSessionsStore().addOrTouch({
      id: "http-contiguous", cwd: "C:\\repo", mtime: "2026-08-01T00:00:00.000Z",
      size: 1, agent: "codex",
    });
    cache.appendBatch("http-contiguous", [{
      index: 1,
      raw: JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "one" } }),
    }]);
    tailApi.readSessionTail.mockResolvedValueOnce({
      totalLines: 3, fromIndex: 2,
      lines: [{ index: 2, raw: "two" }],
    });
    await live.refreshSession("http-contiguous", true);
    expect(tailApi.readSessionRange).not.toHaveBeenCalled();
  });

  it("marks interactive refreshes with interactive priority", async () => {
    const live = useLiveStore();
    tailApi.readSessionTail.mockResolvedValueOnce({ totalLines: 0, fromIndex: 0, lines: [] });
    await live.refreshSession("http-priority", true);
    expect(tailApi.readSessionTail).toHaveBeenCalledWith("http-priority", 20, "interactive");
  });

  it("resolves refresh after the tail while a sparse-gap range is still pending", async () => {
    const cache = useSessionCacheStore();
    const live = useLiveStore();
    useSessionsStore().addOrTouch({
      id: "http-gap-pending", cwd: "C:\\repo", mtime: "2026-08-01T00:00:00.000Z",
      size: 1, agent: "codex",
    });
    cache.appendBatch("http-gap-pending", [{ index: 2598, raw: "start" }]);
    cache.advanceCursor("http-gap-pending", 3192);

    let resolveRange!: (value: { lines: Array<{ index: number; raw: string }> }) => void;
    tailApi.readSessionRange.mockReturnValueOnce(new Promise((resolve) => {
      resolveRange = resolve;
    }));
    tailApi.readSessionTail.mockResolvedValueOnce({
      totalLines: 3193,
      fromIndex: 3132,
      lines: [{ index: 3132, raw: "latest" }],
      supportsCompactRange: true,
    });

    let settled = false;
    const refresh = live.refreshSession("http-gap-pending", true).then(() => { settled = true; });
    await refresh;
    expect(cache.bySession["http-gap-pending"]?.lines[3132]).toBe("latest");
    expect(live.tailFetching["http-gap-pending"]).toBe(false);
    expect(settled).toBe(true);

    resolveRange({ lines: [{ index: 2599, raw: "bridge" }] });
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.bySession["http-gap-pending"]?.lines[2599]).toBe("bridge");
  });

  it("skips automatic gap repair against a legacy server without compact ranges", async () => {
    const cache = useSessionCacheStore();
    const live = useLiveStore();
    useSessionsStore().addOrTouch({
      id: "http-gap-legacy", cwd: "C:\\repo", mtime: "2026-08-01T00:00:00.000Z",
      size: 1, agent: "codex",
    });
    cache.appendBatch("http-gap-legacy", [{ index: 10, raw: "cached" }]);
    cache.advanceCursor("http-gap-legacy", 99);
    tailApi.readSessionTail.mockResolvedValueOnce({
      totalLines: 120,
      fromIndex: 100,
      lines: [{ index: 100, raw: "latest" }],
    });

    await live.refreshSession("http-gap-legacy", true);

    expect(cache.bySession["http-gap-legacy"]?.lines[100]).toBe("latest");
    expect(tailApi.readSessionRange).not.toHaveBeenCalled();
    expect(live.tailFetching["http-gap-legacy"]).toBe(false);
  });

  it("retries an engaged HTTP tail after failure and freshness-coalesces later resume passes", async () => {
    const live = useLiveStore();
    live.subscribeToSession("resume-active", 0, 200);
    tailApi.readSessionTail
      .mockRejectedValueOnce(new Error("network waking"))
      .mockResolvedValue({ totalLines: 0, fromIndex: 0, lines: [] });

    await live.refreshEngaged();
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(1);
    await live.refreshEngaged();
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(2);
    await live.refreshEngaged();
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(2);

    await live.refreshEngaged(true);
    expect(tailApi.readSessionTail).toHaveBeenCalledTimes(3);
    live.closeAll();
  });
});
