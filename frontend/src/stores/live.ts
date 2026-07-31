import { defineStore } from "pinia";
import type { Status } from "@claude-webui/shared/sse";
import type { SessionListItem } from "@claude-webui/shared/api";
import { subscribe } from "../api/ws.js";
import { readSessionTail, markReadRemote } from "../api/sessions.js";
import { useSessionsStore } from "./sessions.js";
import { useSessionCacheStore } from "./session-cache.js";
import { useNotificationsStore } from "./notifications.js";
import { useUiStore } from "./ui.js";
import { usePromptPendingStore } from "./prompt-pending.js";
import { useDraftsStore } from "./drafts.js";
import { useImageDraftsStore } from "./image-drafts.js";
import { usePrefsStore } from "./prefs.js";
import { usePendingInteractionsStore } from "./pending-interactions.js";
import { useSessionSettingsStore } from "./session-settings.js";
import { useBackgroundTasksStore } from "./background-tasks.js";
import type { BackgroundTask } from "@claude-webui/shared/api";
import { osNotify } from "../util/os-notify.js";
import type { InteractionAdded, InteractionRemoved } from "@claude-webui/shared/api";
import { shouldNotifyForSession } from "../util/session-visibility.js";

interface State {
  globalUnsub: (() => void) | null;
  perSession: Record<string, () => void>;
  // True while an engage() HTTP-tail fetch for this session is in flight.
  // MessageList shows a small "syncing latest…" pill so the ~1s mobile/
  // proxy round-trip doesn't read as a frozen screen.
  tailFetching: Record<string, boolean>;
}

// Per-session desync watchdog. The global channel and the per-session tail
// are independent backend pub-subs over the same WS — but in the wild we've
// seen states where session-touched (chokidar global) keeps arriving while
// stream-line/stream-batch (per-session JsonlTail) silently stops, even
// though the WS itself is open and pings are flowing. Two known triggers:
//   1. Reverse-proxy half-open: backend already torn down the socket
//      (1006 abnormal close), client hasn't noticed; reconnect doesn't
//      fire until 2× pong-timeout (~24 s). Doesn't explain multi-minute
//      stalls though — likely combines with #2.
//   2. Per-session tail teardown race during reconnect — onopen re-sends
//      the OLD subscribe params, refreshEngaged then unsubscribes + re-
//      subscribes; if any of those four messages get reordered or dropped,
//      the backend can end up with no tail at all for this session while
//      its global pub keeps emitting.
// Watchdog: on session-touched for an engaged session, arm a 3 s timer.
// Any stream-line / stream-batch arrival clears it. If it fires, we know
// backend wrote something we never received → force re-engage from the
// cache's current nextLineIndex so the backend re-streams the gap.
const staleStreamTimers = new Map<string, ReturnType<typeof setTimeout>>();
const STALE_STREAM_MS = 3000;

// [perf] diagnostic: engage() timestamp per session, consumed once when the
// first stream-batch lands so we can split click→data (WS+backend) from
// data→painted (render). Remove later.
const perfEngageAt = new Map<string, number>();

// Persisted high-water mark of the highest notification seq the frontend has
// processed. Sent back to the backend on subscribe so it can replay anything
// we missed during a brief disconnect (page refresh, sleep, network blip).
const NOTIF_SEQ_KEY = "cw:lastNotifSeq:v1";
const ENGAGE_TAIL_N = 200;
// Smaller tail for the on-tap HTTP fetch: fewer bytes over the proxy = faster
// first paint. The WS subscribe still asks for ENGAGE_TAIL_N and fills the
// rest once the socket is alive; background prefetch (PREFETCH_TAIL_N) keeps
// recent sessions fully warm so most taps render instantly from cache.
const ENGAGE_HTTP_TAIL_N = 60;
const PREFETCH_TAIL_N = 200;
// How many of the most-recent sessions to keep warm via background tail
// prefetch. Recency-ordered (sessions.list is mtime-desc).
const PREFETCH_LIMIT = 8;
const PREFETCH_FRESH_MS = 30_000;
const prefetchFreshAt = new Map<string, number>();
let prefetchWork: Promise<void> | null = null;

function loadLastNotifSeq(): number | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(NOTIF_SEQ_KEY);
    if (!raw) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch { return undefined; }
}

function saveLastNotifSeq(seq: number) {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(NOTIF_SEQ_KEY, String(seq)); } catch { /* noop */ }
}

/**
 * Promotes one specific frontend draft using the authoritative session id
 * returned by that draft's own new-session RPC. Never infer ownership from
 * cwd: several concurrent sessions commonly share the same project folder.
 */
export function promotePendingDraft(draftId: string, sessionId: string): boolean {
  if (!draftId || !sessionId || draftId === sessionId) return false;
  const sessions = useSessionsStore();
  const draft = sessions.pendingDrafts[draftId];
  if (!draft) return false;

  // The filesystem watcher usually added the row before the RPC resolves.
  // Keep a provisional row for the inverse ordering; session-added/touched
  // will merge authoritative metadata into it shortly afterwards.
  if (!sessions.byId[sessionId]) {
    sessions.addOrTouch({
      id: sessionId,
      cwd: draft.cwd,
      mtime: new Date().toISOString(),
      size: 0,
      title: null,
      parentSessionId: null,
      ...(draft.agent ? { agent: draft.agent } : {}),
    });
  }

  usePromptPendingStore().moveSession(draftId, sessionId);
  useDraftsStore().moveSession(draftId, sessionId);
  useImageDraftsStore().moveSession(draftId, sessionId);
  sessions.recordPromotion(draftId, sessionId);

  const prefs = usePrefsStore();
  const group = prefs.groupOf(draftId);
  if (group) {
    prefs.moveToGroup(sessionId, group);
    prefs.moveToGroup(draftId, null);
  }

  const ui = useUiStore();
  if (ui.selectedSessionId === draftId) ui.selectFromHistory(sessionId);
  sessions.dropPending(draftId);
  return true;
}

export const useLiveStore = defineStore("live", {
  state: (): State => ({
    globalUnsub: null,
    perSession: {},
    tailFetching: {},
  }),
  actions: {
    startGlobal() {
      if (this.globalUnsub) return;
      const lastSeq = loadLastNotifSeq();
      const params: Record<string, unknown> = {};
      if (lastSeq !== undefined) params.notifSinceSeq = lastSeq;
      this.globalUnsub = subscribe("global", params, (msg) => {
        this.onGlobal(msg);
      });
    },
    onGlobal(msg: Record<string, unknown>) {
      const kind = msg.kind ?? msg.type;
      const sessions = useSessionsStore();
      if (kind === "session-added") {
        const newId = msg.id as string;
        const cwd = msg.cwd as string;
        sessions.addOrTouch({
          id: newId,
          cwd,
          mtime: msg.mtime as string,
          size: msg.size as number,
          // Carry the agent tag so codex sessions discovered live (via the
          // codex watcher) render with the codex parser. Absent ⇒ claude.
          ...(msg.agent === "codex" ? { agent: "codex" as const } : {}),
          ...(msg.peer === true ? { peer: true } : {}),
          ...(msg.subagent === true ? { subagent: true } : {}),
          parentSessionId: (msg.parentSessionId as string | null | undefined) ?? null,
          preview: (msg.preview as string | null | undefined) ?? null,
          lastTurnAt: (msg.lastTurnAt as string | null | undefined) ?? (msg.mtime as string),
        });
        // Draft promotion is intentionally NOT inferred here. Concurrent
        // top-level sessions in the same cwd are normal, so cwd cannot identify
        // which draft owns this event. The originating new-session RPC returns
        // the exact session id and calls promotePendingDraft instead.
      } else if (kind === "session-touched") {
        const id = msg.id as string;
        const cur = sessions.byId[id];
        if (cur) {
          // Merge in the freshly-extracted preview so the sidebar row reflects
          // the latest turn without waiting for a full listSessions refresh.
          // Falls back to the existing preview if the event didn't carry one
          // (e.g. tail had no qualifying user/assistant text record).
          const newPreview = (msg.preview as string | null | undefined);
          const newLastTurnAt = (msg.lastTurnAt as string | null | undefined);
          // Only overwrite preview when the backend has a non-empty value.
          // Backend returns `null` when the last 64KB tail has no qualifying
          // user/assistant text record (mid-tool_use, just-spawned, etc.) —
          // in those cases the previous preview is still the most-recent
          // human-meaningful content, so keeping it beats blanking the row.
          const keptPreview = newPreview ? newPreview : (cur.preview ?? null);
          const merged: SessionListItem = {
            ...cur,
            mtime: msg.mtime as string,
            size: msg.size as number,
            ...(msg.peer === true || cur.peer === true ? { peer: true } : {}),
            ...(msg.subagent === true || cur.subagent === true ? { subagent: true } : {}),
            preview: keptPreview,
            lastTurnAt: newLastTurnAt ?? (msg.mtime as string),
          };
          sessions.addOrTouch(merged);
        }
        // Desync watchdog — see staleStreamTimers comment at module top.
        // Only arm if (a) we're engaged on this session and (b) no timer
        // is already pending (multiple touched events should not stack).
        if (this.perSession[id] && !staleStreamTimers.has(id)) {
          const t = setTimeout(() => {
            staleStreamTimers.delete(id);
            if (!this.perSession[id]) return;
            const cache = useSessionCacheStore();
            const from = cache.ensure(id).nextLineIndex;
            console.warn(
              `[live] session ${id} desynced (touched without stream); ` +
              `forcing re-engage from line ${from}`,
            );
            this.disengage(id);
            const params: Record<string, unknown> = { sessionId: id, from, tailN: 200 };
            this.perSession[id] = subscribe("session", params, (m) => {
              this.onSessionMsg(id, m);
            });
          }, STALE_STREAM_MS);
          staleStreamTimers.set(id, t);
        }
      } else if (kind === "session-renamed") {
        // Auto-titler or manual rename landed on the backend — update the
        // sessions store so the sidebar swaps short-id → title without a
        // refresh.
        const id = msg.id as string;
        const title = (typeof msg.title === "string" ? msg.title : null);
        const source = (
          msg.titleSource ?? msg.source
        ) as "auto" | "manual" | null | undefined;
        // emoji can be: a string (auto-titler picked one), null (explicit
        // clear, unusual), or undefined (manual rename — preserve existing).
        const emoji = "emoji" in msg ? (msg.emoji as string | null | undefined) : undefined;
        if (id) sessions.setTitle(id, title, source, emoji);
      } else if (kind === "session-retitling") {
        // Backend signals retitle start (inflight=true) or end (inflight=false).
        // SessionRow watches isRetitling(id) and renders the spinner so
        // periodic auto-retitle gets the same visual feedback as a
        // user-clicked Auto button.
        const id = msg.id as string;
        const inflight = msg.inflight as boolean;
        if (id) sessions.setRetitling(id, inflight);
      } else if (kind === "session-boundary") {
        // Boundary = a turn started (user message in) or ended (end_turn).
        // Mid-turn assistant chunks don't fire this. Sidebar uses it for
        // sort so two simultaneously-streaming sessions don't keep swapping
        // positions.
        const id = msg.id as string;
        const at = msg.at as string;
        if (id && at) sessions.setBoundaryAt(id, at);
      } else if (kind === "session-read") {
        // Another device marked this session read. Advance the local row's
        // watermark and clear the badge — but only if the watermark covers the
        // session's latest turn, so a stale read can't clear a genuinely newer
        // reply that landed after the other device read it.
        const id = msg.id as string;
        const at = msg.at as string;
        if (id && at) {
          const row = sessions.byId[id];
          if (row) {
            if (!row.readAt || at > row.readAt) row.readAt = at;
            sessions.reconcileRead(row);
          }
        }
      } else if (kind === "session-status") {
        // Backend broadcasts three per-session signals together:
        //   status — combined alive+mid-turn (drives Thinking pill / dot)
        //   webuiAlive — webui owns a live claude (drives Kill pill)
        //   compacting — CLI is mid-/compact (drives "Compacting…" label)
        const id = msg.id as string;
        const newStatus = (msg.status as Status | null) ?? null;
        const webuiAlive = msg.webuiAlive === true;
        const compacting = msg.compacting === true;
        sessions.setStatus(id, newStatus, webuiAlive, compacting);
      } else if (kind === "session-settings") {
        // Per-session pill-row state. Preserve omitted fields so one setting
        // update cannot erase another.
        // these whenever the wire confirms a change (system/init,
        // system/status) or the user sets an override via set-model /
        // set-permission-mode RPCs. Null fields mean the backend has no
        // record; FE falls back to jsonl cache derivation, then prefs default.
        const id = msg.id as string;
        if (id) useSessionSettingsStore().apply({
          id,
          ...(msg.model !== undefined ? { model: msg.model as string | null } : {}),
          ...(msg.permissionMode !== undefined ? { permissionMode: msg.permissionMode as string | null } : {}),
          ...(msg.effort !== undefined ? { effort: msg.effort as string | null } : {}),
          ...(msg.serviceTier !== undefined ? { serviceTier: msg.serviceTier as string | null } : {}),
        });
      } else if (kind === "capacity-retry") {
        const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
        const turnId = typeof msg.turnId === "string" ? msg.turnId : "";
        const attempt = typeof msg.attempt === "number" ? msg.attempt : 0;
        const maxAttempts = typeof msg.maxAttempts === "number" ? msg.maxAttempts : 0;
        const delayMs = typeof msg.delayMs === "number" ? msg.delayMs : 0;
        const suppliedRetryAt = typeof msg.retryAt === "string" ? msg.retryAt : "";
        // Backward-compatible with a backend that already emits retry progress
        // but predates the absolute retry timestamp. This keeps the freshly
        // published frontend useful before the user's next backend restart.
        const retryAt = Number.isFinite(Date.parse(suppliedRetryAt))
          ? suppliedRetryAt
          : new Date(Date.now() + Math.max(0, delayMs)).toISOString();
        if (
          sessionId
          && turnId
          && attempt > 0
          && maxAttempts >= attempt
          && delayMs >= 0
        ) {
          sessions.setCapacityRetry(sessionId, { turnId, attempt, maxAttempts, delayMs, retryAt });
        }
      } else if (kind === "session-error") {
        const message = typeof msg.message === "string" ? msg.message : "Agent turn failed.";
        const details = typeof msg.details === "string" && msg.details ? `\n${msg.details}` : "";
        useNotificationsStore().pushError(`${message}${details}`, {
          title: msg.agent === "codex" ? "Codex turn failed" : "Agent turn failed",
        });
      } else if (kind === "background-tasks") {
        // Backend's per-session background-work list changed (subagent /
        // workflow / background-shell launched or finished). Full-list
        // replace; the store derives the completion flash itself.
        const id = msg.sessionId as string;
        const tasks = msg.tasks as BackgroundTask[] | undefined;
        if (id && Array.isArray(tasks)) useBackgroundTasksStore().apply(id, tasks);
      } else if (kind === "notif-baseline") {
        // Backend's current notification high-water mark. Two purposes:
        // (1) first-ever connect — adopt as our floor so we don't bump
        //     unread for the entire history buffer.
        // (2) reconnect after a backend RESTART — backend's nextSeq counter
        //     resets to 1 on every process start, but our localStorage may
        //     still hold the high seq from before the restart. Without
        //     resetting we'd silently dedup-drop every new notification
        //     (seq=1 <= stored=50). If the baseline is BELOW our stored
        //     value, that's the tell that backend restarted; reset.
        const seq = msg.seq as number;
        if (typeof seq !== "number") return;
        const stored = loadLastNotifSeq() ?? 0;
        if (stored === 0 || seq < stored) saveLastNotifSeq(seq);
      } else if (kind === "interaction-added") {
        // Cross-session permission notification. Backend fans this on global
        // so the user knows about pending allow/deny even while looking at
        // another session. Also populate the pending-interactions store so
        // background sessions have inline cards ready when the user opens
        // them. Both paths dedup by requestId.
        const evt = msg as unknown as InteractionAdded;
        usePendingInteractionsStore().onAdded(evt);
        if (evt.subtype === "can_use_tool" && evt.toolName) {
          const prefs = usePrefsStore();
          const item = sessions.byId[evt.sessionId];
          if (prefs.hidden.includes(evt.sessionId)) return;
          if ((item?.peer === true || (msg as Record<string, unknown>).peer === true) && !prefs.showPeerSessions) return;
          // Same rule as the `notification` branch: the session you have
          // OPEN never toasts — the inline InteractionCard /
          // AskUserQuestionInteractive surface is right there in the message
          // list. Holds regardless of tab visibility (matches the WeChat
          // "no notification for the chat you're in" behavior).
          const ui = useUiStore();
          if (evt.sessionId === ui.selectedSessionId) return;
          const notifications = useNotificationsStore();
          const input = (evt.input ?? {}) as Record<string, unknown>;
          if (evt.toolName === "AskUserQuestion") {
            // Question toast: no Allow/Deny — clicking jumps to the session
            // where the inline form lives. Body = first question text, so
            // the user can decide whether to switch contexts.
            const qs = input.questions;
            const first = Array.isArray(qs) && qs.length > 0 ? qs[0] : null;
            const body = first && typeof (first as { question?: unknown }).question === "string"
              ? (first as { question: string }).question
              : "AskUserQuestion";
            notifications.pushQuestion({
              sessionId: evt.sessionId,
              cwd: item?.cwd ?? "",
              requestId: evt.requestId,
              body: body.slice(0, 200),
            });
          } else {
            // Body summary: best-effort short command / path snippet so the
            // user can decide without clicking through. Falls back to tool
            // name on tools whose input doesn't carry a short key.
            const summary = typeof input.command === "string" ? input.command
              : typeof input.file_path === "string" ? input.file_path
              : typeof input.path === "string" ? input.path
              : evt.toolName;
            notifications.pushPermission({
              sessionId: evt.sessionId,
              cwd: item?.cwd ?? "",
              requestId: evt.requestId,
              toolName: evt.toolName,
              body: String(summary).slice(0, 200),
            });
          }
        }
      } else if (kind === "interaction-removed") {
        const evt = msg as unknown as InteractionRemoved;
        usePendingInteractionsStore().onRemoved(evt);
        useNotificationsStore().dismissByRequestId(evt.requestId);
      } else if (kind === "notification") {
        // Dedup against persisted seq — protects against replay-after-
        // reconnect double-fires (the WS layer re-sends our subscribe
        // params on reconnect, which would re-trigger backend replay).
        const seq = msg.seq as number;
        if (typeof seq === "number") {
          const stored = loadLastNotifSeq() ?? 0;
          if (seq <= stored) return;
          saveLastNotifSeq(seq);
        }
        // Foreground AND tab-visible session: the assistant reply renders
        // inline in the message list, the toast/badge on top is noise.
        // If the user is selected on this session but has the tab in the
        // background (or focus elsewhere), still treat as unread — they
        // weren't "looking" when the reply landed.
        // The session you currently have OPEN never toasts and never bumps
        // unread — WeChat-style. The reply renders inline in the message
        // list; a toast on top is noise. This holds even when the tab is
        // backgrounded: coming back to a conversation you already had open
        // shouldn't greet you with a stale toast for it (the old `&&
        // visible` gate did exactly that, which was the complaint).
        const id = msg.id as string;
        const ui = useUiStore();
        if (id === ui.selectedSessionId) {
          // A reply landed while you're actively viewing this session on THIS
          // device. It's read here, so advance the cross-device watermark too —
          // otherwise the other devices keep showing it unread. Best-effort:
          // uses the freshly-arrived timestamp (falls back to the row's).
          const item = sessions.byId[id];
          const at = (msg.timestamp as string | undefined) || item?.lastTurnAt || item?.mtime;
          if (at) {
            if (item) item.readAt = at;
            markReadRemote(id, at);
          }
          return;
        }
        const prefs = usePrefsStore();
        const item = sessions.byId[id];
        if (!shouldNotifyForSession({
          id,
          peer: msg.peer === true || item?.peer === true,
          subagent: msg.subagent === true || item?.subagent === true,
        }, prefs)) return;
        sessions.bumpUnread(id);
        const body = (msg.body as string) ?? "";
        if (!body.trim()) return;
        const notifications = useNotificationsStore();
        notifications.push({
          uuid: msg.uuid as string,
          sessionId: id,
          cwd: msg.cwd as string,
          title: msg.title as string,
          body,
        });
        osNotify({ sessionId: id, title: msg.title as string, body });
      }
    },
    async engage(id: string) {
      if (this.perSession[id]) return;
      perfEngageAt.set(id, performance.now()); // [perf] click→data/render split
      const cache = useSessionCacheStore();
      // IMPORTANT: do NOT await cache.restore here. Loading the cached
      // lines from IDB and letting Vue re-derive `timeline` / `decorated`
      // over them is the dominant page-open stall — multi-second on long
      // sessions ("10s 才到底" feedback). Subscribe to the backend tail
      // FIRST so the latest 200 lines paint immediately, then fire restore
      // in the background to fill in older history. The user gets the
      // bottom of the conversation in <1 s; scrolling up takes a moment
      // longer to reveal history but doesn't block the initial paint.
      //
      // Pass from=0 because the backend's tail mode (tailN=200) reads
      // ~200 KB from EOF backwards regardless of `from` — passing the
      // cached nextLineIndex would just risk a race where restore lands
      // BEFORE the WS subscribe and we miss tail lines. Always-from-0 +
      // tail mode is the cheapest correct path.
      const params: Record<string, unknown> = { sessionId: id, from: 0, tailN: ENGAGE_TAIL_N };
      this.perSession[id] = subscribe("session", params, (msg) => {
        this.onSessionMsg(id, msg);
      });
      // Fast first paint AND mobile-resume correctness for EVERY session (was
      // codex-only). The HTTP tail is independent of the WebSocket: on mobile a
      // suspended OS leaves the socket a zombie (readyState OPEN, bytes go
      // nowhere, onclose never fires) for up to ~63s until the heartbeat
      // declares it dead. During that window a WS `subscribe` frame is sent
      // into the void, so opening a session would show only stale IDB-cached
      // lines until a full page reload rebuilt the socket — the long-standing
      // "手机端点开刷不出新消息,得整页刷新" complaint. This GET hits the
      // generic /tail route (agent-agnostic) and paints the latest lines
      // regardless of socket health; the WS stays subscribed for live
      // increments and self-heals via the watchdog. appendBatch is merge-safe
      // (dedups by index), so the redundant overlap with the WS replay on a
      // healthy socket is harmless. Smaller tail (ENGAGE_HTTP_TAIL_N) keeps
      // the round-trip snappy; tailFetching drives the "syncing latest…" pill.
      this.tailFetching[id] = true;
      void this.fetchTailIntoCache(id, ENGAGE_HTTP_TAIL_N)
        .catch((err) => console.warn(`[live] HTTP tail prefetch failed for ${id}: ${(err as Error).message}`))
        .finally(() => { this.tailFetching[id] = false; });
      // Background restore. cache.restore is now merge-safe — it only
      // fills empty slots and takes max(WS-known, cached) for nextLineIndex,
      // so it can't clobber WS-streamed tail lines if it lands later.
      void cache.restore(id);
    },
    // Pull the latest `n` lines over HTTP (independent of the WS) into the
    // session cache. Merge-safe via appendBatch (dedups by index, forward-
    // stream wins). Shared by engage() (small tail, on tap) and prefetchTails
    // (full tail, background warming).
    async fetchTailIntoCache(id: string, n: number) {
      const cache = useSessionCacheStore();
      const tail = await readSessionTail(id, n);
      const items = tail.lines
        .filter((l) => typeof l?.index === "number" && Number.isFinite(l.index) && typeof l?.raw === "string")
        .map((l) => ({ index: l.index, raw: l.raw }));
      if (items.length > 0) cache.appendBatch(id, items);
      // totalLines is the physical source count, including Claude records the
      // backend intentionally filters from the response. Keep reconnect
      // anchored after them without materializing empty array slots.
      cache.advanceCursor(id, tail.totalLines);
    },
    // Warm the cache for the most-recently-active sessions so tapping one
    // renders instantly from cache instead of waiting on the on-tap fetch.
    // Fired on boot, reconnect, and resume. Coalesce overlapping recovery
    // sweeps and keep a short freshness window so one wake-up burst cannot
    // download the same recent 8 MiB-bounded tails repeatedly.
    async prefetchTails(limit = PREFETCH_LIMIT) {
      if (prefetchWork) return prefetchWork;
      const sessions = useSessionsStore();
      const now = Date.now();
      const ids = sessions.list
        .filter((s) => !s.id.startsWith("draft:"))
        .slice(0, limit)
        .map((s) => s.id)
        // The engaged session fetches its own fresh tail in engage().
        .filter((id) => !this.perSession[id])
        .filter((id) => now - (prefetchFreshAt.get(id) ?? 0) >= PREFETCH_FRESH_MS);
      if (!ids.length) return;
      let work!: Promise<void>;
      work = Promise.allSettled(ids.map((id) => this.fetchTailIntoCache(id, PREFETCH_TAIL_N)))
        .then((results) => {
          const completedAt = Date.now();
          results.forEach((result, index) => {
            if (result.status === "fulfilled") prefetchFreshAt.set(ids[index]!, completedAt);
          });
        })
        .finally(() => {
          if (prefetchWork === work) prefetchWork = null;
        });
      prefetchWork = work;
      return work;
    },
    disengage(id: string) {
      const unsub = this.perSession[id];
      if (unsub) {
        unsub();
        delete this.perSession[id];
      }
      const t = staleStreamTimers.get(id);
      if (t) { clearTimeout(t); staleStreamTimers.delete(id); }
    },
    async resetAndReengage(id: string) {
      this.disengage(id);
      const cache = useSessionCacheStore();
      await cache.clear(id);
      await this.engage(id);
    },
    // Re-subscribe every currently-engaged session, telling the backend to
    // resume streaming from the cache's current nextLineIndex. Used after
    // visibilitychange→visible (mobile lock-screen unlock) and after a fresh
    // WS reconnect, because:
    //   1. The subscriptions map in ws.ts captures `from` at first engage
    //      and never updates it. On reconnect ws.ts re-subscribes with the
    //      OLD `from`, so the backend would replay the entire history we
    //      already have. Catching up that way works (cache dedups by index)
    //      but burns network on a multi-hundred-line session.
    //   2. wsWake() pings the socket; if pong comes back, it concludes the
    //      socket is alive and skips reconnect. But events the backend
    //      pushed during the OS-frozen window may have been silently
    //      dropped — the socket looks alive in both directions but the
    //      mobile OS ate the in-flight bytes. Without a forced re-subscribe
    //      the active chat sits on a stale tail until the next assistant
    //      chunk lands.
    // Disengage + engage tears down the backend tail and rebuilds it
    // anchored on the latest nextLineIndex, which is what we want.
    refreshEngaged() {
      // Inlined subscribe — does NOT call engage(), because engage's
      // cache.restore() reads from IDB which can be older than the
      // in-memory lines we already have (saves are debounced 200ms).
      // Restoring here would clobber recent lines we haven't flushed.
      const cache = useSessionCacheStore();
      const ids = Object.keys(this.perSession);
      for (const id of ids) {
        this.disengage(id);
        const from = cache.ensure(id).nextLineIndex;
        const params: Record<string, unknown> = { sessionId: id, from, tailN: 200 };
        this.perSession[id] = subscribe("session", params, (msg) => {
          this.onSessionMsg(id, msg);
        });
      }
    },
    onSessionMsg(id: string, msg: Record<string, unknown>) {
      const type = msg.type as string;

      // Any per-session traffic for this id proves the tail is alive —
      // disarm the desync watchdog.
      const t = staleStreamTimers.get(id);
      if (t) { clearTimeout(t); staleStreamTimers.delete(id); }

      if (type === "stream-reset") {
        // Legacy path — full clear + await re-stream. Kept for backward
        // compat with older backends; new backends fire stream-truncate
        // (below) which is dramatically faster.
        console.log(`[live] stream-reset for session=${id} — clearing cache, awaiting re-stream`);
        const cache = useSessionCacheStore();
        void cache.clear(id);
        return;
      }
      if (type === "stream-truncate") {
        // Smart path (new): backend already counted surviving lines, trim
        // our reactive array to match. No re-stream needed — we already
        // had those lines from before the rewind.
        const keepCount = msg.keepCount as number;
        if (typeof keepCount !== "number" || !Number.isFinite(keepCount)) return;
        console.log(`[live] stream-truncate for session=${id} keepCount=${keepCount}`);
        const cache = useSessionCacheStore();
        cache.truncateTo(id, keepCount);
        return;
      }

      if (type === "stream-cursor") {
        const nextIndex = msg.nextIndex as number;
        if (typeof nextIndex !== "number" || !Number.isFinite(nextIndex)) return;
        const cache = useSessionCacheStore();
        cache.advanceCursor(id, nextIndex);
        return;
      }

      if (type === "stream-line") {
        const idx = msg.index as number;
        const data = msg.data as string;
        if (typeof idx !== "number" || !Number.isFinite(idx)) return;
        const cache = useSessionCacheStore();
        cache.appendLine(id, idx, data);
      }

      // interaction-added / interaction-removed used to ride per-session here.
      // They now route exclusively through the global channel (see
      // api/ws.ts handleMessage special-case) so the toast layer can pop
      // cross-session permission prompts. onGlobal handles both the store
      // mutation and the toast push.

      if (type === "stream-batch") {
        // Tail replay arrives as a single batch. Doing this through one
        // reactive mutation (cache.appendBatch) instead of N appendLine calls
        // is the difference between ~20 ms and ~2 s of cumulative reactivity
        // overhead on a 200-line tail. Backend only emits batches for the
        // initial replay; live updates still use stream-line.
        const lines = msg.lines as { index: number; data: string }[] | undefined;
        if (!Array.isArray(lines) || lines.length === 0) return;
        const items = lines
          .filter((l) => typeof l?.index === "number" && Number.isFinite(l.index) && typeof l?.data === "string")
          .map((l) => ({ index: l.index, raw: l.data }));
        if (items.length === 0) return;
        const cache = useSessionCacheStore();
        cache.appendBatch(id, items);
        // [perf] split click→data (WS+backend) from data→painted (render).
        const t0 = perfEngageAt.get(id);
        if (t0 !== undefined) {
          perfEngageAt.delete(id);
          const dataMs = performance.now() - t0;
          console.log(`[perf] engage→first-batch ${id}: ${dataMs.toFixed(0)}ms (${items.length} lines)`);
          // Two rAFs: the first runs before paint of the batch-driven render,
          // the second after the browser has painted that frame.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            console.log(`[perf] engage→painted ${id}: ${(performance.now() - t0).toFixed(0)}ms total`);
          }));
        }
      }
    },
    closeAll() {
      if (this.globalUnsub) { this.globalUnsub(); this.globalUnsub = null; }
      for (const unsub of Object.values(this.perSession)) unsub();
      this.perSession = {};
      for (const t of staleStreamTimers.values()) clearTimeout(t);
      staleStreamTimers.clear();
    },
  },
});
