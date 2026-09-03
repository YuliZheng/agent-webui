import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../src/api/ws.js", () => ({
  connected: { __v_isRef: true, value: false },
  request: requestMock,
  WsError: class WsError extends Error {},
}));

import {
  isForwardedSlashCommand,
  clearSessionGoal,
  getAgentCapabilities,
  getSessionGoal,
  listSessions,
  flushPendingReadMarks,
  markReadRemote,
  newSession,
  readFullCodexContextUsage,
  readSessionRange,
  readSessionTail,
  refreshBackend,
  sendPrompt,
  setSessionGoal,
  setSessionServiceTier,
} from "../src/api/sessions.js";

describe("sessions API slash command escaping", () => {
  beforeEach(() => {
    requestMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("defuses unknown leading-slash prompts", async () => {
    await sendPrompt("s1", "/not-a-command");
    expect(requestMock).toHaveBeenCalledWith(
      "prompt",
      { sessionId: "s1", prompt: " /not-a-command", images: [] },
      { timeoutMs: 200_000 },
    );
  });

  it("preserves built-in forwarded slash commands", async () => {
    await sendPrompt("s1", "/compact ");
    expect(requestMock).toHaveBeenCalledWith(
      "prompt",
      { sessionId: "s1", prompt: "/compact", images: [] },
      { timeoutMs: 200_000 },
    );
  });

  it("preserves provider-reported slash commands", async () => {
    await sendPrompt("s1", "/init", undefined, undefined, ["init"]);
    expect(requestMock).toHaveBeenCalledWith(
      "prompt",
      { sessionId: "s1", prompt: "/init", images: [] },
      { timeoutMs: 200_000 },
    );
  });

  it("forwards dispatch and safely retries an idempotent prompt across reconnects", async () => {
    const onDispatched = vi.fn();
    await sendPrompt("s1", "hello", undefined, "client-1", undefined, onDispatched);
    expect(requestMock).toHaveBeenCalledWith(
      "prompt",
      { sessionId: "s1", prompt: "hello", images: [], clientUuid: "client-1" },
      { timeoutMs: 200_000, onSent: onDispatched, retryOnReconnect: true },
    );
  });

  it("queues monotonic read watermarks as reconnect-safe mutations", async () => {
    vi.useFakeTimers();
    try {
      markReadRemote("s-read", "2026-08-29T10:00:00.000Z");
      markReadRemote("s-read", "2026-08-29T10:00:01.000Z");
      await flushPendingReadMarks();
      expect(requestMock).toHaveBeenCalledWith(
        "mark-read",
        { sessionId: "s-read", at: "2026-08-29T10:00:01.000Z" },
        { retryOnReconnect: true },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends Fast as the priority service tier instead of a reasoning effort", async () => {
    requestMock.mockResolvedValueOnce({ applies: "next-turn" });
    await expect(setSessionServiceTier("s1", "priority")).resolves.toBe("next-turn");
    expect(requestMock).toHaveBeenCalledWith(
      "set-service-tier",
      { sessionId: "s1", serviceTier: "priority" },
    );
  });

  it("requests Codex model service-tier capabilities for the current cwd", async () => {
    const capabilities = {
      agent: "codex",
      models: [],
      permissionModes: [],
      sandboxModes: [],
      defaults: { serviceTier: "priority" },
    };
    requestMock.mockResolvedValueOnce(capabilities);
    await expect(getAgentCapabilities("codex", "C:\\work")).resolves.toEqual(capabilities);
    expect(requestMock).toHaveBeenCalledWith("get-agent-capabilities", {
      agent: "codex",
      cwd: "C:\\work",
    });
  });

  it("preserves an explicit Fast-off override when creating a draft session", async () => {
    await newSession({ cwd: "C:\\work", prompt: "hello", agent: "codex", serviceTier: "" });
    expect(requestMock).toHaveBeenCalledWith(
      "new-session",
      { cwd: "C:\\work", prompt: "hello", images: [], agent: "codex", serviceTier: "" },
      { timeoutMs: 200_000 },
    );
  });

  it("forwards a new-session idempotency key", async () => {
    requestMock.mockResolvedValueOnce({ sessionId: "created-session" });
    const result = await newSession({ cwd: "/work", prompt: "hello", clientUuid: "create-1" });
    expect(requestMock).toHaveBeenCalledWith(
      "new-session",
      { cwd: "/work", prompt: "hello", images: [], clientUuid: "create-1" },
      { timeoutMs: 200_000, retryOnReconnect: true },
    );
    expect(result).toEqual({ sessionId: "created-session" });
  });

  it("does not treat absolute paths as slash commands", () => {
    expect(isForwardedSlashCommand("/home/alice", ["home"])).toBe(false);
  });
});

describe("sessions API HTTP reads", () => {
  beforeEach(() => {
    requestMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("lists sessions over HTTP so mobile resume is not blocked on a stale WebSocket", async () => {
    const rows = [{ id: "s1", cwd: "/x", mtime: "2026-06-12T00:00:00Z", size: 1 }];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => rows,
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await expect(listSessions()).resolves.toEqual(rows);

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      credentials: "include",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
  });

  it("aborts a wedged session list instead of leaving home sync pending forever", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })) as unknown as typeof fetch;
      vi.stubGlobal("fetch", fetchMock);

      const result = expect(listSessions()).rejects.toThrow("连接超时");
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out when session-list headers arrive but the response body stalls", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: () => new Promise<never>(() => undefined),
      })) as unknown as typeof fetch;
      vi.stubGlobal("fetch", fetchMock);

      const result = expect(listSessions()).rejects.toThrow("连接超时");
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a wedged pull refresh and leaves it retryable", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })) as unknown as typeof fetch;
      vi.stubGlobal("fetch", fetchMock);

      const result = expect(refreshBackend()).rejects.toThrow("刷新超时");
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      expect(fetchMock).toHaveBeenCalledWith("/api/refresh", expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out when pull-refresh headers arrive but the response body stalls", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: () => new Promise<never>(() => undefined),
      })) as unknown as typeof fetch;
      vi.stubGlobal("fetch", fetchMock);

      const result = expect(refreshBackend()).rejects.toThrow("刷新超时");
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads session tail and ranges over HTTP for fast mobile first paint", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ totalLines: 2, fromIndex: 1, lines: [{ index: 1, raw: "{}" }] }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await readSessionTail("abc/def", 200, "interactive");
    await readSessionRange("abc/def", 10, 20);
    await readSessionRange("abc/def", 10, 20, { mode: "compact" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/abc%2Fdef/tail?n=200&priority=interactive",
      expect.objectContaining({
        credentials: "include",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/abc%2Fdef/range?from=10&to=20",
      expect.objectContaining({
        credentials: "include",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/abc%2Fdef/range?from=10&to=20&mode=compact",
      expect.objectContaining({
        credentials: "include",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("aborts a wedged mobile tail request instead of showing syncing forever", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("tail aborted")), { once: true });
      })) as unknown as typeof fetch;
      vi.stubGlobal("fetch", fetchMock);

      const result = expect(readSessionTail("slow", 60)).rejects.toThrow("tail aborted");
      await vi.advanceTimersByTimeAsync(20_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a wedged history-range request so loading earlier stays retryable", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("range aborted")), { once: true });
      })) as unknown as typeof fetch;
      vi.stubGlobal("fetch", fetchMock);

      const result = expect(readSessionRange("slow", 0, 200)).rejects.toThrow("range aborted");
      await vi.advanceTimersByTimeAsync(20_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests a server-side full-rollout usage summary without transcript rows", async () => {
    const summary = {
      tokens: 12_000,
      limit: 200_000,
      reportedTokens: 12_000,
      contributors: [],
      completeHistoryScan: true,
      recordsScanned: 2_501,
      oversizedRecords: 0,
      compactionCount: 2,
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => summary,
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await expect(readFullCodexContextUsage("abc/def", 200_000)).resolves.toEqual(summary);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/abc%2Fdef/context-usage?autoCompactLimit=200000",
      { credentials: "include", cache: "no-store" },
    );
  });
});

describe("sessions API Codex goal RPCs", () => {
  beforeEach(() => {
    requestMock.mockClear();
  });

  it("waits long enough for Codex goal metadata RPCs", async () => {
    await getSessionGoal("s1");
    await setSessionGoal("s1", { objective: "ship it", status: "active" });
    await clearSessionGoal("s1");

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      "codex-goal-get",
      { sessionId: "s1" },
      { timeoutMs: 60_000 },
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      "codex-goal-set",
      { sessionId: "s1", objective: "ship it", status: "active" },
      { timeoutMs: 60_000 },
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      3,
      "codex-goal-clear",
      { sessionId: "s1" },
      { timeoutMs: 60_000 },
    );
  });
});
