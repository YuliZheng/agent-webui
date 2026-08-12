import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";

// Minimal WebSocket mock that lets us drive open / message events explicitly.
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.last = this;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  // Test helpers
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  static last: MockWebSocket | null = null;
}

beforeEach(() => {
  // @ts-expect-error - test override
  globalThis.WebSocket = MockWebSocket;
  // @ts-expect-error - test override
  globalThis.location = { protocol: "http:", host: "127.0.0.1:8787" };
  vi.resetModules();
  MockWebSocket.last = null;
});

afterEach(async () => {
  // resetModules() only removes the module from the import cache; it does not
  // stop the watchdog interval or reconnect timers owned by the old instance.
  // Disconnect before the next test resets modules so no stale client can wake
  // up later and replace MockWebSocket.last behind another test's back.
  const ws = await import("../src/api/ws.js");
  ws.disconnect();
  vi.useRealTimers();
});

describe("ws client", () => {
  it("queues requests sent before WS opens, flushes on open", async () => {
    const ws = await import("../src/api/ws.js");
    ws.connect();

    // Fire request immediately while WS is still CONNECTING
    const promise = ws.request<{ home: string }>("get-me");

    // Nothing should be sent yet - it's queued
    const mock = MockWebSocket.last!;
    expect(mock.sent.length).toBe(0);

    // Open the WS
    mock.open();

    // After open: should send ping (1) + queued request (1)
    expect(mock.sent.length).toBeGreaterThanOrEqual(2);
    const sentMessages = mock.sent.map((s) => JSON.parse(s));
    expect(sentMessages.some((m) => m.type === "ping")).toBe(true);
    const getMeMsg = sentMessages.find((m) => m.type === "get-me");
    expect(getMeMsg).toBeDefined();
    expect(getMeMsg.reqId).toBeDefined();

    // Server responds
    mock.receive({ type: "result", reqId: getMeMsg.reqId, ok: true, data: { home: "/home/test" } });

    const result = await promise;
    expect(result.home).toBe("/home/test");
  });

  it("reports dispatch only when the frame is handed to an open WebSocket", async () => {
    const ws = await import("../src/api/ws.js");
    ws.connect();
    const onSent = vi.fn();

    const promise = ws.request("prompt", { sessionId: "s1", prompt: "hello" }, { onSent });
    expect(onSent).not.toHaveBeenCalled();

    const mock = MockWebSocket.last!;
    mock.open();
    expect(onSent).toHaveBeenCalledTimes(1);

    const prompt = mock.sent.map((s) => JSON.parse(s)).find((message) => message.type === "prompt");
    mock.receive({ type: "result", reqId: prompt.reqId, ok: true, data: {} });
    await promise;
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("re-sends subscriptions on open", async () => {
    const ws = await import("../src/api/ws.js");
    ws.connect();

    const handler = vi.fn();
    ws.subscribe("global", {}, handler);

    const mock = MockWebSocket.last!;
    mock.open();

    const subscribeMsgs = mock.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.type === "subscribe" && m.channel === "global");
    expect(subscribeMsgs.length).toBeGreaterThanOrEqual(1);

    // Push event from server should hit the handler
    mock.receive({ type: "session-added", id: "s1", cwd: "/x", mtime: "t", size: 0 });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: "session-added", id: "s1" }));
  });

  it("matches result/error to pending request by reqId", async () => {
    const ws = await import("../src/api/ws.js");
    ws.connect();
    MockWebSocket.last!.open();

    const p1 = ws.request<{ a: number }>("foo");
    const p2 = ws.request<{ a: number }>("bar");

    const mock = MockWebSocket.last!;
    const foo = mock.sent.map((s) => JSON.parse(s)).find((m) => m.type === "foo");
    const bar = mock.sent.map((s) => JSON.parse(s)).find((m) => m.type === "bar");
    expect(foo.reqId).not.toBe(bar.reqId);

    // Respond to bar first (out of order)
    mock.receive({ type: "result", reqId: bar.reqId, ok: true, data: { a: 2 } });
    mock.receive({ type: "result", reqId: foo.reqId, ok: true, data: { a: 1 } });

    expect((await p1).a).toBe(1);
    expect((await p2).a).toBe(2);
  });

  it("rejects with WsError on error response", async () => {
    const ws = await import("../src/api/ws.js");
    ws.connect();
    MockWebSocket.last!.open();

    const p = ws.request("bad");
    const mock = MockWebSocket.last!;
    const msg = mock.sent.map((s) => JSON.parse(s)).find((m) => m.type === "bad");

    mock.receive({ type: "error", reqId: msg.reqId, code: 404, message: "not found" });

    await expect(p).rejects.toThrow("not found");
    await expect(p).rejects.toMatchObject({ code: 404 });
  });

  it("routes per-session push events only to the matching session subscription", async () => {
    const ws = await import("../src/api/ws.js");
    ws.connect();
    MockWebSocket.last!.open();

    const handlerA = vi.fn();
    const handlerB = vi.fn();
    ws.subscribe("session", { sessionId: "A", from: 0 }, handlerA);
    ws.subscribe("session", { sessionId: "B", from: 0 }, handlerB);

    const mock = MockWebSocket.last!;
    // Server pushes a stream line for session A only
    mock.receive({ type: "stream-line", sessionId: "A", index: 0, data: "{}" });

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).not.toHaveBeenCalled();
  });

  it("routes global push events to the global subscription only", async () => {
    const ws = await import("../src/api/ws.js");
    ws.connect();
    MockWebSocket.last!.open();

    const globalHandler = vi.fn();
    const sessionHandler = vi.fn();
    ws.subscribe("global", {}, globalHandler);
    ws.subscribe("session", { sessionId: "X", from: 0 }, sessionHandler);

    MockWebSocket.last!.receive({ type: "session-added", id: "Y", cwd: "/x", mtime: "t", size: 0 });

    expect(globalHandler).toHaveBeenCalledTimes(1);
    expect(sessionHandler).not.toHaveBeenCalled();
  });

  it("connected ref reflects pong receipt", async () => {
    const ws = await import("../src/api/ws.js");
    expect(ws.connected.value).toBe(false);

    ws.connect();
    const mock = MockWebSocket.last!;
    mock.open();

    // After open, connected goes true
    expect(ws.connected.value).toBe(true);

    // Pong keeps it true
    mock.receive({ type: "pong", seq: 1 });
    expect(ws.connected.value).toBe(true);
  });

  it("wake replaces a stale non-open socket even if onclose never fired", async () => {
    const ws = await import("../src/api/ws.js");
    ws.connect();
    const first = MockWebSocket.last!;
    first.open();
    expect(ws.connected.value).toBe(true);

    // Mobile Safari/proxy failure mode: the module still has a WebSocket
    // object, but it is no longer open and no onclose callback/reconnect timer
    // ran. Tap-to-retry and pull-to-refresh both call wake(), so wake() must
    // rebuild the socket instead of treating non-null `ws` as healthy.
    first.readyState = MockWebSocket.CLOSED;
    ws.connected.value = false;

    ws.wake();

    const second = MockWebSocket.last!;
    expect(second).not.toBe(first);
    expect(second.readyState).toBe(MockWebSocket.CONNECTING);

    second.open();
    expect(ws.connected.value).toBe(true);
  });

  it("rejects an already-sent request as outcome-unknown when forcing replacement", async () => {
    const ws = await import("../src/api/ws.js");
    ws.connect();
    const first = MockWebSocket.last!;
    first.open();

    const request = ws.request("new-session", { cwd: "/x", prompt: "hello" });
    expect(first.sent.some((raw) => JSON.parse(raw).type === "new-session")).toBe(true);

    ws.wake({ forceReconnect: true });

    await expect(request).rejects.toThrow(/new-session: connection replaced .*outcome is unknown/i);
    expect(MockWebSocket.last).not.toBe(first);
  });

  it("replays an explicitly idempotent request after forcing replacement", async () => {
    const ws = await import("../src/api/ws.js");
    ws.connect();
    const first = MockWebSocket.last!;
    first.open();
    const onSent = vi.fn();

    const request = ws.request<{ sessionId: string }>(
      "new-session",
      { cwd: "/x", prompt: "hello", clientUuid: "stable-create-1" },
      { retryOnReconnect: true, onSent },
    );
    const firstFrame = first.sent
      .map((raw) => JSON.parse(raw))
      .find((message) => message.type === "new-session");
    expect(firstFrame).toBeDefined();
    expect(onSent).toHaveBeenCalledTimes(1);

    ws.wake({ forceReconnect: true });
    const second = MockWebSocket.last!;
    expect(second).not.toBe(first);
    second.open();

    const replay = second.sent
      .map((raw) => JSON.parse(raw))
      .find((message) => message.type === "new-session");
    expect(replay).toEqual(firstFrame);
    // Composer dispatch is a one-time UI transition, not one per wire retry.
    expect(onSent).toHaveBeenCalledTimes(1);

    second.receive({
      type: "result",
      reqId: replay.reqId,
      ok: true,
      data: { sessionId: "created-once" },
    });
    await expect(request).resolves.toEqual({ sessionId: "created-once" });
  });

  it("replays only explicitly idempotent sent requests after a natural close", async () => {
    const ws = await import("../src/api/ws.js");
    ws.connect();
    const first = MockWebSocket.last!;
    first.open();

    const safe = ws.request<{ accepted: boolean }>(
      "prompt",
      { sessionId: "s1", prompt: "hello", clientUuid: "stable-prompt-1" },
      { retryOnReconnect: true },
    );
    const unsafe = ws.request("set-title", { sessionId: "s1", title: "new title" });

    first.close();
    await expect(unsafe).rejects.toThrow(/set-title: connection closed; request outcome is unknown/i);

    // Skip the reconnect backoff just as a foreground/online event would.
    ws.wake();
    const second = MockWebSocket.last!;
    second.open();
    const replayed = second.sent.map((raw) => JSON.parse(raw));
    const prompt = replayed.find((message) => message.type === "prompt");
    expect(prompt).toBeDefined();
    expect(replayed.some((message) => message.type === "set-title")).toBe(false);

    second.receive({ type: "result", reqId: prompt.reqId, ok: true, data: { accepted: true } });
    await expect(safe).resolves.toEqual({ accepted: true });
  });

  it("does not send an idempotent retry after its request deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const ws = await import("../src/api/ws.js");
      ws.connect();
      const first = MockWebSocket.last!;
      first.open();

      const request = ws.request(
        "prompt",
        { sessionId: "s1", prompt: "hello", clientUuid: "expired-prompt" },
        { retryOnReconnect: true, timeoutMs: 50 },
      );
      const rejection = expect(request).rejects.toThrow(/timed out after 50ms/i);
      first.close();
      ws.wake();
      const second = MockWebSocket.last!;

      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      second.open();
      expect(second.sent.map((raw) => JSON.parse(raw)).some((message) => message.type === "prompt")).toBe(false);
      ws.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an unsent queued request across a forced connecting-socket replacement", async () => {
    const ws = await import("../src/api/ws.js");
    ws.connect();
    const first = MockWebSocket.last!;
    const request = ws.request<{ ok: boolean }>("queued-operation");

    ws.wake({ forceReconnect: true });
    const second = MockWebSocket.last!;
    expect(second).not.toBe(first);
    second.open();

    const sent = second.sent.map((raw) => JSON.parse(raw));
    const queued = sent.find((message) => message.type === "queued-operation");
    expect(queued).toBeDefined();
    second.receive({ type: "result", reqId: queued.reqId, ok: true, data: { ok: true } });
    await expect(request).resolves.toEqual({ ok: true });
  });
});
