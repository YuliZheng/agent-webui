import { describe, expect, it, vi } from "vitest";
import { MainSocket, WsError } from "@/api/ws";

class FakeWebSocket extends EventTarget {
  readyState = 0;
  sent: string[] = [];
  closeCode?: number;
  send(value: string) { this.sent.push(value); }
  close(code?: number) { this.closeCode = code; this.readyState = 3; this.dispatchEvent(new CloseEvent("close")); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

describe("MainSocket", () => {
  it("correlates result and error responses by reqId", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new MainSocket(() => { const socket = new FakeWebSocket(); sockets.push(socket); return socket as unknown as WebSocket; }, "ws://test/ws/main");
    const result = client.request<{ ok: number }>("get-sessions");
    sockets[0]!.open(); const request = JSON.parse(sockets[0]!.sent[0]!);
    sockets[0]!.message({ type: "result", reqId: request.reqId, ok: true, data: { ok: 1 } });
    await expect(result).resolves.toEqual({ ok: 1 });
    const failure = client.request("bad"); const bad = JSON.parse(sockets[0]!.sent.at(-1)!);
    sockets[0]!.message({ type: "error", reqId: bad.reqId, code: 409, message: "conflict" });
    await expect(failure).rejects.toEqual(expect.objectContaining({ code: 409, message: "conflict" })); client.close();
  });

  it("times out requests and resubscribes after replacement", async () => {
    vi.useFakeTimers(); const sockets: FakeWebSocket[] = [];
    const client = new MainSocket(() => { const socket = new FakeWebSocket(); sockets.push(socket); return socket as unknown as WebSocket; }, "ws://test/ws/main");
    client.subscribe({ channel: "session", sessionId: "s1", from: 7 }); sockets[0]!.open();
    expect(sockets[0]!.sent.map((value) => JSON.parse(value)).filter((x) => x.type === "subscribe")).toHaveLength(1);
    client.replace(); sockets[1]!.open();
    expect(sockets[1]!.sent.map((value) => JSON.parse(value)).find((x) => x.type === "subscribe")).toMatchObject({ sessionId: "s1", from: 7 });
    const request = client.request("slow", {}, 10); const rejected = expect(request).rejects.toBeInstanceOf(WsError); await vi.advanceTimersByTimeAsync(11);
    await rejected; client.close(); vi.useRealTimers();
  });

  it("never sends an offline request after its timeout has been reported", async () => {
    vi.useFakeTimers(); const sockets: FakeWebSocket[] = [];
    const client = new MainSocket(() => { const socket = new FakeWebSocket(); sockets.push(socket); return socket as unknown as WebSocket; }, "ws://test/ws/main");
    const request = client.request("prompt", { sessionId: "s", prompt: "do not send late" }, 10);
    const rejected = expect(request).rejects.toMatchObject({ code: 408 }); await vi.advanceTimersByTimeAsync(11); await rejected;
    sockets[0]!.open(); expect(sockets[0]!.sent).toEqual([]); client.close(); vi.useRealTimers();
  });

  it("carries the latest notification sequence into reconnect subscription", () => {
    const sockets: FakeWebSocket[] = [];
    const client = new MainSocket(() => { const socket = new FakeWebSocket(); sockets.push(socket); return socket as unknown as WebSocket; }, "ws://test/ws/main");
    client.subscribe({ channel: "global", notifSinceSeq: 2 }); sockets[0]!.open(); client.updateGlobalNotifSinceSeq(9);
    client.replace(); sockets[1]!.open();
    const subscription = sockets[1]!.sent.map((value) => JSON.parse(value)).find((item) => item.type === "subscribe");
    expect(subscription).toMatchObject({ channel: "global", notifSinceSeq: 9 }); client.close();
  });

  it("drops bounded initial-tail mode after receiving a forward index", () => {
    const sockets: FakeWebSocket[] = [];
    const client = new MainSocket(() => { const socket = new FakeWebSocket(); sockets.push(socket); return socket as unknown as WebSocket; }, "ws://test/ws/main");
    client.subscribe({ channel: "session", sessionId: "large", from: 0, tailN: 200 }); sockets[0]!.open();
    expect(sockets[0]!.sent.map(value => JSON.parse(value)).find(item => item.type === "subscribe")).toMatchObject({ sessionId: "large", from: 0, tailN: 200 });
    client.updateSessionFrom("large", 7686); client.replace(); sockets[1]!.open();
    const resumed = sockets[1]!.sent.map(value => JSON.parse(value)).find(item => item.type === "subscribe");
    expect(resumed).toMatchObject({ sessionId: "large", from: 7686 });
    expect(resumed).not.toHaveProperty("tailN"); client.close();
  });
});
