import { ref } from "vue";

const DEFAULT_TIMEOUT_MS = 15_000;
// Heartbeat. 5s ping cadence so corporate proxies that silently kill "idle"
// WebSockets at 30-60s have a harder time judging the connection idle.
// Pong timeout of 12s is slightly more than 2× the interval so a single
// dropped pong still leaves room for the next ping/pong round-trip to land
// before we declare the socket dead. Closing on a single missed pong was
// the dominant cause of "disconnected" cycles on proxied + mobile network
// — log analysis showed lots of `code=1000 pings=2` short-lived sockets,
// each one a normal ping/pong round followed by ONE missed pong → close.
const PING_INTERVAL_MS = 5_000;
const PONG_TIMEOUT_MS = 12_000;
// Tolerate this many consecutive pong misses before closing. With 5s
// interval + 12s timeout: miss-1 at ~12s, miss-2 at ~29s, miss-3 at ~46s,
// miss-4 at ~63s. Bumped from 2 → 4 after backend [ws-close] logs showed
// recurring `pong-timeout-x2` closes with `gapMax` clustered at 44–48s —
// a fixed-period blackout (likely Windows Wi-Fi NIC power mgmt, corporate
// VPN rekey, or browser tab background-throttle) that 2-miss tolerance
// (~29s) consistently fails to ride out. 4 misses → ~63s tolerance clears
// it with margin. Trade-off: a truly dead WS now takes ~34s longer to
// detect, but the 3s debounced banner cushions that and false-positive
// reconnects were the dominant pain.
const MAX_MISSED_PONGS = 4;
const RECONNECT_BASE_MS = 3_000;
// Capped at 10s (was 30s) — iOS Safari's setTimeout throttling can push a
// 30s backoff to 60s+ in practice, leaving the "Disconnected" banner up for
// a full minute before the next attempt. 10s gives 6 attempts/min vs 2 with
// minimal cost (a failed WS open is cheap) and recovers from transient
// proxy / mobile-network blips much faster.
const RECONNECT_MAX_MS = 10_000;

export const connected = ref(false);

// Debounced "the socket has been down long enough to warrant a banner".
// 99% of disconnects behind the proxy reconnect inside the 3s window, so showing
// a banner the instant `connected` flips makes the UI feel hostile (banner
// flashes constantly during a normal session) without telling the user
// anything actionable. Only show after a sustained dropout.
export const disconnectedAwhile = ref(false);
const DISCONNECT_BANNER_DELAY_MS = 3_000;
let disconnectBannerTimer: ReturnType<typeof setTimeout> | null = null;
function syncDisconnectedAwhile(): void {
  if (connected.value) {
    if (disconnectBannerTimer) { clearTimeout(disconnectBannerTimer); disconnectBannerTimer = null; }
    disconnectedAwhile.value = false;
    return;
  }
  if (disconnectBannerTimer) return; // already armed
  disconnectBannerTimer = setTimeout(() => {
    disconnectBannerTimer = null;
    if (!connected.value) disconnectedAwhile.value = true;
  }, DISCONNECT_BANNER_DELAY_MS);
}

type PushHandler = (msg: Record<string, unknown>) => void;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sent: boolean;
  type: string;
  /**
   * Only present for mutations carrying their own backend idempotency key.
   * It may be replayed when this client deliberately supersedes a socket.
   */
  reconnectRetryFrame?: string;
}

interface Subscription {
  channel: string;
  params: Record<string, unknown>;
  handler: PushHandler;
}

let ws: WebSocket | null = null;
let reqIdCounter = 0;
const pending = new Map<string, PendingRequest>();
const subscriptions = new Map<string, Subscription>();

interface QueuedFrame {
  data: string | Blob | ArrayBuffer;
  onSent?: () => void;
  // Requests can time out or be rejected while the socket is still
  // connecting. Do not deliver such a stale mutation on a later reconnect.
  shouldSend?: () => boolean;
}

// Messages queued while the socket is CONNECTING (or null/CLOSED while
// waiting to reconnect). Flushed in onopen, after re-subscribes.
const sendQueue: QueuedFrame[] = [];

// Heartbeat state
let pingSeq = 0;
let pingTimer: ReturnType<typeof setTimeout> | null = null;
let pongTimer: ReturnType<typeof setTimeout> | null = null;
// Consecutive pong-timeout misses. Reset to 0 on every pong receipt.
// When >= MAX_MISSED_PONGS we declare the socket dead and close.
let missedPongs = 0;

// Reconnect state
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_BASE_MS;

// Connectivity watchdog. The event-driven recovery paths (onclose →
// scheduleReconnect, wake() from focus/visibility/online) all assume SOME
// event eventually fires. In the wild that assumption breaks on DESKTOP:
// the tab keeps foreground focus forever, so wake() never runs, and the
// network stack can leave a socket wedged in CONNECTING (VPN rekey black-
// holes the WS upgrade — no onopen, no onclose, no TCP timeout for minutes)
// or CLOSED-without-onclose (the Safari state documented in wake() below).
// Either way: connected=false, no reconnect timer, and no code path left
// that would ever call doConnect() again → permanently dead until a full
// page refresh. The watchdog is the unconditional safety net: a slow
// interval that force-reconnects whenever we're disconnected with no
// recovery in flight. Background-tab timer throttling (1/min) only makes
// it slower, never wrong — and a return to the tab fires wake() anyway.
const WATCHDOG_INTERVAL_MS = 10_000;
// How long a CONNECTING socket gets before the watchdog declares the
// attempt black-holed and supersedes it. Browsers have no WS handshake
// timeout of their own (Chrome rides TCP SYN retries for ~2 min).
const CONNECT_TIMEOUT_MS = 10_000;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let connectStartedAt = 0;

function watchdogTick() {
  if (connected.value) return;
  if (reconnectTimer) return; // normal backoff in progress
  if (ws) {
    // OPEN but connected=false means the heartbeat already declared it
    // dead and closeWith() is in flight — onclose will reconnect.
    if (ws.readyState === WebSocket.OPEN) return;
    // Give a fresh CONNECTING attempt its window before superseding.
    if (ws.readyState === WebSocket.CONNECTING && Date.now() - connectStartedAt < CONNECT_TIMEOUT_MS) return;
  }
  console.warn("[ws] watchdog: disconnected with no recovery in flight — forcing reconnect");
  reconnectDelay = RECONNECT_BASE_MS;
  doConnect();
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/main`;
}

function clearTimers() {
  if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function sendRaw(
  data: string | Blob | ArrayBuffer,
  onSent?: () => void,
  shouldSend?: () => boolean,
) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
    onSent?.();
  } else {
    // Queue until connection opens (or until next reconnect's onopen flushes).
    sendQueue.push({
      data,
      ...(onSent ? { onSent } : {}),
      ...(shouldSend ? { shouldSend } : {}),
    });
  }
}

function sendJson(
  msg: Record<string, unknown>,
  onSent?: () => void,
  shouldSend?: () => boolean,
) {
  sendRaw(JSON.stringify(msg), onSent, shouldSend);
}

function schedulePing() {
  if (pingTimer) clearTimeout(pingTimer);
  pingTimer = setTimeout(() => {
    sendJson({ type: "ping", seq: pingSeq });
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
      pongTimer = null;
      missedPongs++;
      if (missedPongs >= MAX_MISSED_PONGS) {
        console.warn(`[ws] closing — ${missedPongs} consecutive pong timeouts`);
        connected.value = false; syncDisconnectedAwhile();
        closeWith(`pong-timeout-x${missedPongs}`);
      } else {
        // Tolerate. The next scheduled ping will give us another chance to
        // hear back. Keep the chain alive.
        console.warn(`[ws] pong timeout #${missedPongs}, retrying`);
        schedulePing();
      }
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);
}

// Close with a reason so the backend log can distinguish causes.
// Browser ws.close(code, reason) writes the reason into the close frame,
// which the backend's [ws-close] line surfaces. Reason length capped at
// 123 bytes per RFC 6455 close-frame limit (125 - 2 status code bytes).
function closeWith(reason: string) {
  try { ws?.close(1000, reason.slice(0, 123)); } catch { /* ignore */ }
}

function replaceSocket(reason: string) {
  const old = ws;
  if (!old) return;
  // A request already handed to the old socket may have committed on the
  // backend even when its response has not arrived yet. Once the handlers are
  // detached below that response can never be observed, so settle those
  // promises immediately as an explicitly indeterminate outcome instead of
  // leaving them to hang until their (sometimes 200 s) timeout. Requests still
  // waiting in sendQueue remain pending and are safely flushed to the
  // replacement socket.
  settleSentPendingForReplacement(
    `connection replaced (${reason}); request outcome is unknown`,
    reason === "reconnect-supersede",
  );
  // We are intentionally superseding this socket. Detach handlers so a late
  // close/error from the old instance cannot reject current requests, null out
  // `ws`, or schedule another reconnect over the fresh socket.
  old.onopen = null;
  old.onmessage = null;
  old.onclose = null;
  old.onerror = null;
  try { old.close(1000, reason.slice(0, 123)); } catch { /* ignore */ }
  ws = null;
}

function handleMessage(ev: MessageEvent) {
  // Binary messages are not expected from server in current protocol
  if (typeof ev.data !== "string") return;

  let msg: Record<string, unknown>;
  try { msg = JSON.parse(ev.data); } catch { return; }

  const type = msg.type as string;

  // Pong
  if (type === "pong") {
    const seq = msg.seq as number;
    pingSeq = seq + 1;
    connected.value = true; syncDisconnectedAwhile();
    missedPongs = 0;
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    schedulePing();
    return;
  }

  // Result / error (response to a request)
  if (type === "result" || type === "error") {
    const reqId = msg.reqId as string;
    const p = pending.get(reqId);
    if (!p) return;
    pending.delete(reqId);
    clearTimeout(p.timer);
    if (type === "result") {
      p.resolve(msg.data);
    } else {
      const code = msg.code as number;
      const message = msg.message as string;
      p.reject(new WsError(code, message));
    }
    return;
  }


  // Push event — route by target.
  // Per-session events carry sessionId → dispatch to that session's subscription.
  // Global events (session-added / session-touched / notification) → dispatch to "global".
  // Exception: interaction-added / interaction-removed carry sessionId but the
  // backend fans them over the global channel so the toast layer can pop
  // cross-session permission prompts. Force these to the global sub regardless
  // of sessionId; live.ts:onGlobal populates the per-session pending store too.
  if (type === "interaction-added" || type === "interaction-removed" || type === "background-tasks") {
    // background-tasks also carries sessionId but fans out on the global
    // channel (backend broadcasts it to every socket) so background sessions'
    // task state stays fresh without a per-session subscription.
    const sub = subscriptions.get("global");
    if (sub) sub.handler(msg);
    return;
  }
  const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : null;
  if (sessionId) {
    const sub = subscriptions.get(`session:${sessionId}`);
    if (sub) sub.handler(msg);
  } else {
    const sub = subscriptions.get("global");
    if (sub) sub.handler(msg);
  }
}

function rejectAllPending(reason: string) {
  for (const [reqId, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new WsError(0, reason));
  }
  pending.clear();
}

function settleSentPendingForReplacement(reason: string, allowIdempotentRetry: boolean) {
  for (const [reqId, p] of pending) {
    if (!p.sent) continue;
    if (allowIdempotentRetry && p.reconnectRetryFrame) {
      p.sent = false;
      sendQueue.push({
        data: p.reconnectRetryFrame,
        onSent: () => {
          const current = pending.get(reqId);
          if (current === p) current.sent = true;
        },
        shouldSend: () => pending.get(reqId) === p,
      });
      continue;
    }
    clearTimeout(p.timer);
    p.reject(new WsError(0, `${p.type}: ${reason}`));
    pending.delete(reqId);
  }
}

function doConnect() {
  clearTimers();
  replaceSocket("reconnect-supersede");

  // The superseded socket's handlers were detached above, so its onclose
  // can never flip `connected` for us. Without this, a forced reconnect
  // from a connected state leaves `connected=true` while the replacement
  // socket is still CONNECTING — which blinds the watchdog (its first
  // guard) AND swallows the false→true transition App.vue's wsConnected
  // watch needs to trigger the post-reconnect resync/refreshEngaged.
  connected.value = false; syncDisconnectedAwhile();

  pingSeq = 0;
  connectStartedAt = Date.now();
  const socket = new WebSocket(wsUrl());
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    reconnectDelay = RECONNECT_BASE_MS;
    connected.value = true; syncDisconnectedAwhile();
    missedPongs = 0;

    // Start heartbeat
    socket.send(JSON.stringify({ type: "ping", seq: pingSeq }));
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
      pongTimer = null;
      missedPongs++;
      if (missedPongs >= MAX_MISSED_PONGS) {
        console.warn(`[ws] onopen pong timeout x${missedPongs}, closing`);
        connected.value = false; syncDisconnectedAwhile();
        closeWith(`onopen-pong-timeout-x${missedPongs}`);
      } else {
        console.warn(`[ws] onopen pong timeout #${missedPongs}, retrying`);
        schedulePing();
      }
    }, PONG_TIMEOUT_MS);

    // Re-subscribe all active subscriptions
    for (const sub of subscriptions.values()) {
      socket.send(JSON.stringify({ type: "subscribe", channel: sub.channel, ...sub.params }));
    }

    // Flush any messages queued while we were CONNECTING.
    while (sendQueue.length > 0) {
      const frame = sendQueue.shift()!;
      if (frame.shouldSend && !frame.shouldSend()) continue;
      socket.send(frame.data);
      frame.onSent?.();
    }
  };

  socket.onmessage = (ev) => {
    if (ws !== socket) return;
    handleMessage(ev);
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    connected.value = false; syncDisconnectedAwhile();
    clearTimers();
    ws = null;
    rejectAllPending("connection closed");
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose fires after onerror
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    doConnect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

/** Open the WebSocket connection. Call once from App.vue. */
export function connect() {
  if (!watchdogTimer) watchdogTimer = setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
  doConnect();
}

/**
 * Fast-resync entry point for visibilitychange→visible (lock-screen unlock,
 * tab return).
 *
 * Behavior:
 *   - If we have an OPEN socket, kick the heartbeat by sending an immediate
 *     ping using the STANDARD pong window (PONG_TIMEOUT_MS). The earlier
 *     3-second tight window was the dominant source of false-positive
 *     reconnects: every alt-tab back to the app on a momentarily-slow
 *     mobile network would close + reconnect, even though the WS itself
 *     was fine. The ping itself is enough to surface a truly frozen socket
 *     within ~10s instead of waiting up to ~15s for the next scheduled ping.
 *   - If the socket is closed and we're sitting in the reconnect backoff,
 *     skip the wait and reconnect right now.
 */
export function wake(opts: { forceReconnect?: boolean } = {}) {
    if (opts.forceReconnect) {
    reconnectDelay = RECONNECT_BASE_MS;
    doConnect();
    return;
    }

  if (ws?.readyState === WebSocket.OPEN) {
    // Fresh slate on wake. A pongTimer that was sitting through a system
    // suspend fires immediately on resume (setTimeout doesn't tick during
    // sleep; on wake any expired timers drain in a burst), incrementing
    // missedPongs based on a "miss" that never had a chance to succeed.
    // That stale miss then stacks onto the wake() ping's own pong window
    // and pushes us over MAX_MISSED_PONGS before the WS has had a fair
    // chance to prove it's alive. Whatever happened during sleep doesn't
    // count.
    missedPongs = 0;
    if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    sendJson({ type: "ping", seq: pingSeq });
    pongTimer = setTimeout(() => {
      pongTimer = null;
      missedPongs++;
      if (missedPongs >= MAX_MISSED_PONGS) {
        console.warn(`[ws] wake pong timeout x${missedPongs}, closing`);
        connected.value = false; syncDisconnectedAwhile();
        closeWith(`wake-pong-timeout-x${missedPongs}`);
      } else {
        console.warn(`[ws] wake pong timeout #${missedPongs}, retrying via schedulePing`);
        schedulePing();
      }
    }, PONG_TIMEOUT_MS);
    return;
  }
  // A young CONNECTING attempt is probably fine — a slow WS upgrade through
  // the proxy takes seconds. The resume sweep calls wake() at 0/0.5/1.5/5/15s;
  // without this guard each pass would supersede (kill) the previous pass's
  // still-handshaking socket, so a slow-but-working upgrade never completes.
  // Past the timeout window, fall through and supersede it (black-holed).
  if (ws?.readyState === WebSocket.CONNECTING && Date.now() - connectStartedAt < CONNECT_TIMEOUT_MS) {
    return;
  }
  // Manual retry / mobile resume must be decisive. In the wild Safari/proxy
  // can leave us with a non-null WebSocket in CONNECTING/CLOSING/CLOSED and no
  // onclose callback/reconnect timer. The old branch treated that as "nothing
  // to do", so tap-to-retry and pull-to-refresh were no-ops until a full page
  // reload rebuilt the module state.
  reconnectDelay = RECONNECT_BASE_MS;
  doConnect();
}

/** Close and stop reconnecting. */
export function disconnect() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  clearTimers();
  sendQueue.length = 0;
  replaceSocket("manual-disconnect");
  connected.value = false; syncDisconnectedAwhile();
  rejectAllPending("disconnected");
}

/**
 * Send a request and wait for the matching result/error.
 * Rejects on timeout or WsError.
 */
export function request<T = void>(
    type: string,
    params: Record<string, unknown> = {},
    opts: {
      timeoutMs?: number;
      onSent?: () => void;
      /**
       * Replay on a deliberate client-side socket replacement. Callers must
       * opt in only when params contain a stable backend idempotency key.
       */
      retryOnReconnect?: boolean;
    } = {},
): Promise<T> {
    const reqId = String(++reqIdCounter);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const frame = JSON.stringify({ type, reqId, ...params });

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new WsError(0, `request ${type} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pending.set(reqId, {
      resolve: resolve as (data: unknown) => void,
      reject,
      timer,
      sent: false,
      type,
      ...(opts.retryOnReconnect ? { reconnectRetryFrame: frame } : {}),
    });

    try {
      sendRaw(
        frame,
        () => {
          const current = pending.get(reqId);
          if (current) current.sent = true;
          opts.onSent?.();
        },
        () => pending.has(reqId),
      );
    } catch (error) {
      clearTimeout(timer);
      pending.delete(reqId);
      reject(error instanceof Error ? error : new WsError(0, `request ${type} could not be sent`));
    }
  });
}

/**
 * Send a binary frame (for audio uploads).
 * Call immediately after the corresponding text-frame request.
 */
export function sendBinary(blob: Blob) {
    sendRaw(blob);
}

/**
 * Subscribe to a push channel. Returns an unsubscribe function.
 * On reconnect, subscriptions are automatically re-sent.
 */
export function subscribe(
    channel: string,
    params: Record<string, unknown>,
    handler: PushHandler,
): () => void {
    const key = channel === "global" ? "global" : `session:${params.sessionId}`;
    subscriptions.set(key, { channel, params, handler });
    // Send the control frame ONLY if the socket is OPEN — do NOT fall back to the
    // sendQueue. onopen re-subscribes every entry in the `subscriptions` map (the
    // source of truth), so queueing the frame would make a reconnect double-send:
    // once from the onopen map loop AND once from the flushed queue. Two subscribe
    // frames for the same session race in the backend (concurrent tail builds),
    // leaking an orphaned fs.watch+poll. A subscribe issued while closed is
    // already covered by the map re-subscribe on the next open.
    sendControlIfOpen({ type: "subscribe", channel, ...params });

  return () => {
    subscriptions.delete(key);
    // Same reasoning: an unsubscribe while closed is moot (a fresh socket has
    // nothing to unsubscribe, and onopen won't re-subscribe a key we just
    // removed from the map), so don't queue it.
    sendControlIfOpen({ type: "unsubscribe", channel, ...params });
  };
}

function sendControlIfOpen(msg: Record<string, unknown>) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Error class for WS responses. */
export class WsError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}
