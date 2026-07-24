import type { PushEvent } from "@/types";

export class WsError extends Error {
  constructor(public readonly code: number, message: string) { super(message); this.name = "WsError"; }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Subscription = { args: Record<string, unknown> };
type WsFactory = (url: string) => WebSocket;

const OPEN = 1;
const CONNECTING = 0;

export class MainSocket extends EventTarget {
  private socket?: WebSocket;
  private pending = new Map<string, Pending>();
  private sendQueue: Array<{ payload: string; reqId?: string }> = [];
  private subscriptions = new Map<string, Subscription>();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private watchdogTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private reqSeq = 0;
  private pingSeq = 0;
  private intentional = false;
  private lastPong = Date.now();

  constructor(private readonly factory: WsFactory = (url) => new WebSocket(url), private readonly baseUrl?: string) {
    super();
  }

  get connected(): boolean { return this.socket?.readyState === OPEN; }

  connect(): void {
    if (this.socket?.readyState === OPEN || this.socket?.readyState === CONNECTING) return;
    this.intentional = false;
    const url = this.baseUrl ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/main`;
    const ws = this.factory(url);
    this.socket = ws;
    ws.addEventListener("open", () => this.onOpen(ws));
    ws.addEventListener("message", (event) => this.onMessage(event));
    ws.addEventListener("close", () => this.onClose(ws));
    ws.addEventListener("error", () => { /* close drives reconnect */ });
  }

  close(): void {
    this.intentional = true;
    clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.rejectPending(new WsError(499, "WebSocket closed"));
    this.socket?.close(1000, "client close");
    this.socket = undefined;
  }

  replace(): void {
    const old = this.socket;
    this.socket = undefined;
    this.rejectPending(new WsError(409, "WebSocket connection replaced"));
    old?.close(1000, "replaced");
    this.intentional = false;
    this.connect();
  }

  request<T = unknown>(type: string, args: Record<string, unknown> = {}, timeout = 15_000): Promise<T> {
    const reqId = `r${++this.reqSeq}`;
    const payload = JSON.stringify({ type, reqId, ...args });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        this.sendQueue = this.sendQueue.filter((item) => item.reqId !== reqId);
        reject(new WsError(408, `${type} timed out`));
      }, timeout);
      this.pending.set(reqId, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send(payload, reqId);
      this.connect();
    });
  }

  ping(): void {
    this.send(JSON.stringify({ type: "ping", seq: ++this.pingSeq }));
  }

  subscribe(args: Record<string, unknown>): void {
    const key = this.subscriptionKey(args);
    this.subscriptions.set(key, { args: { ...args } });
    if (this.connected) void this.request("subscribe", args).catch(() => undefined);
    else this.connect();
  }

  unsubscribe(args: Record<string, unknown>): void {
    this.subscriptions.delete(this.subscriptionKey(args));
    if (this.connected) void this.request("unsubscribe", args).catch(() => undefined);
  }

  updateSessionFrom(sessionId: string, from: number, tailN?: number): void {
    const key = `session:${sessionId}`;
    const existing = this.subscriptions.get(key);
    if (existing) existing.args = { channel: "session", sessionId, from, ...(tailN ? { tailN } : {}) };
  }

  updateGlobalNotifSinceSeq(seq: number): void {
    const existing = this.subscriptions.get("global");
    if (existing) existing.args = { ...existing.args, notifSinceSeq: seq };
  }

  wake(): void {
    if (!this.connected) this.connect();
    else if (Date.now() - this.lastPong > 30_000) this.socket?.close(4000, "stale");
  }

  private subscriptionKey(args: Record<string, unknown>): string {
    return args.channel === "session" ? `session:${String(args.sessionId)}` : "global";
  }

  private send(payload: string, reqId?: string): void {
    if (this.socket?.readyState === OPEN) this.socket.send(payload);
    else this.sendQueue.push({ payload, reqId });
  }

  private onOpen(ws: WebSocket): void {
    if (ws !== this.socket) return;
    this.reconnectAttempt = 0;
    this.lastPong = Date.now();
    const queued = this.sendQueue.splice(0);
    for (const item of queued) ws.send(item.payload);
    for (const { args } of this.subscriptions.values()) {
      const reqId = `r${++this.reqSeq}`;
      ws.send(JSON.stringify({ type: "subscribe", reqId, ...args }));
    }
    this.startHeartbeat();
    this.dispatchEvent(new CustomEvent("connection", { detail: { connected: true, reconnect: true } }));
  }

  private onMessage(event: MessageEvent): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(String(event.data)) as Record<string, unknown>; } catch { return; }
    if (message.type === "pong") {
      this.lastPong = Date.now();
      this.resetWatchdog();
      this.dispatchEvent(new CustomEvent("push", { detail: message }));
      return;
    }
    if (typeof message.reqId === "string" && (message.type === "result" || message.type === "error")) {
      const pending = this.pending.get(message.reqId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.reqId);
      if (message.type === "error" || message.ok === false) {
        pending.reject(new WsError(typeof message.code === "number" ? message.code : 500, String(message.message ?? "Request failed")));
      } else pending.resolve(message.data);
      return;
    }
    this.dispatchEvent(new CustomEvent<PushEvent>("push", { detail: message as PushEvent }));
  }

  private onClose(ws: WebSocket): void {
    if (ws !== this.socket) return;
    this.socket = undefined;
    this.stopHeartbeat();
    this.rejectPending(new WsError(503, "WebSocket disconnected"));
    this.dispatchEvent(new CustomEvent("connection", { detail: { connected: false } }));
    if (!this.intentional) {
      const delay = Math.min(15_000, 300 * 2 ** Math.min(this.reconnectAttempt++, 6)) + Math.random() * 250;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }
  }

  private rejectPending(error: Error): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.sendQueue = [];
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => this.ping(), 15_000);
    this.resetWatchdog();
  }

  private resetWatchdog(): void {
    clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => this.socket?.close(4000, "heartbeat timeout"), 45_000);
  }

  private stopHeartbeat(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.watchdogTimer);
  }
}

export const mainSocket = new MainSocket();

export function installWakeHandlers(socket = mainSocket, afterWake?: () => void): () => void {
  const wake = () => {
    socket.wake();
    afterWake?.();
  };
  window.addEventListener("online", wake);
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", wake);
  return () => {
    window.removeEventListener("online", wake);
    window.removeEventListener("focus", wake);
    document.removeEventListener("visibilitychange", wake);
  };
}
