import { defineStore } from "pinia";
import type { Status } from "@claude-webui/shared/sse";
import type { SessionListItem } from "@claude-webui/shared/api";
import { subscribe } from "../api/ws.js";
import {
  readSessionRange,
  readSessionTail,
  type SessionTailPriority,
} from "../api/sessions.js";
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
import type { InteractionAdded, InteractionRemoved } from "@claude-webui/shared/api";
import { shouldNotifyForSession } from "../util/session-visibility.js";
import { codexRuntimeProgressEvent } from "../util/codex-runtime-progress.js";
import { isCodexDurableUserMessage } from "../util/pending-prompt-reconciliation.js";

interface State {
  globalUnsub: (() => void) | null;
  perSession: Record<string, () => void>;
  // True while an engage() HTTP-tail fetch for this session is in flight.
  // MessageList shows a small "syncing latest…" pill so the ~1s mobile/
  // proxy round-trip doesn't read as a frozen screen.
  tailFetching: Record<string, boolean>;
  // Last HTTP-tail synchronization failure. Kept per session so MessageList
  // can offer a local retry without turning a transient failure into a global
  // toast storm.
  tailErrors: Record<string, string | undefined>;
  // Latest observable activity for a running Codex turn. SessionRow and
  // MessageList share this so the sidebar mirrors the open conversation.
  turnProgress: Record<string, string>;
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
// A valid stream-line / non-empty stream-batch arrival clears it. Control
// frames such as stream-reset/cursor do not prove that visible content caught
// up. If it fires, pull one
// ground-truth HTTP tail. Rebuilding the WS subscription here created a worse
// race; future touched events keep HTTP catch-up alive while WS self-heals.
const staleStreamTimers = new Map<string, ReturnType<typeof setTimeout>>();
const staleStreamHttpAt = new Map<string, number>();
const STALE_STREAM_MS = 3000;
// Filtered/internal transcript writes can emit session-touched without a
// renderable stream-line. Keep the first fast recovery, then cap fallback
// traffic instead of downloading the same tail after every bookkeeping row.
const STALE_STREAM_HTTP_MIN_GAP_MS = 15_000;

// A completion notification is emitted only at end_turn, but the sidebar
// should become unread as soon as the first visible assistant reply lands.
// Track sessions already bumped by an assistant preview so streaming updates
// and the later completion notification still count as one unread reply.
const earlyAssistantUnread = new Set<string>();
const activeToolLabels = new Map<string, Map<string, string>>();
// The global preview/notification channel can reach the browser while the
// independent transcript tail is stalled. When an assistant reply becomes
// visible for the conversation currently on screen, debounce one authoritative
// HTTP catch-up. This repair is intentionally independent of WS control frames:
// a mobile-resume stream-reset/cursor must not cancel it.
const viewedTranscriptRepairTimers = new Map<string, ReturnType<typeof setTimeout>>();
const VIEWED_TRANSCRIPT_REPAIR_MS = 200;

function clearStaleStreamTimer(id: string): void {
  const timer = staleStreamTimers.get(id);
  if (!timer) return;
  clearTimeout(timer);
  staleStreamTimers.delete(id);
}

function compactSidebarPreview(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function isNewerTurnTimestamp(
  next: string | null | undefined,
  previous: string | null | undefined,
): boolean {
  const nextMs = next ? Date.parse(next) : Number.NaN;
  if (!Number.isFinite(nextMs)) return false;
  const previousMs = previous ? Date.parse(previous) : Number.NaN;
  return !Number.isFinite(previousMs) || nextMs > previousMs;
}

// A selected conversation is only "read" when the user can actually see it.
// Installed PWAs remain alive while minimized or behind another window, so
// selection alone must not suppress their unread badge and OS notification.
function isSessionActivelyViewed(id: string, selectedSessionId: string | null): boolean {
  if (id !== selectedSessionId) return false;
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

function timestampCovers(
  known: string | null | undefined,
  incoming: string | null | undefined,
): boolean {
  const knownMs = known ? Date.parse(known) : Number.NaN;
  const incomingMs = incoming ? Date.parse(incoming) : Number.NaN;
  return Number.isFinite(knownMs)
    && Number.isFinite(incomingMs)
    && knownMs >= incomingMs;
}

function replayLineConflicts(current: string | undefined, incoming: string): boolean {
  if (!current || current === incoming) return false;
  // The bounded transcript reader may substitute an oversized-record marker
  // while another path already has the exact record (or vice versa). That is
  // a fidelity upgrade/downgrade, not evidence that the source was rewritten;
  // appendBatch already keeps the better copy.
  if (
    current.includes('"type":"agent-webui-record-omitted"')
    || incoming.includes('"type":"agent-webui-record-omitted"')
  ) return false;
  return true;
}

// A reset is immediately followed by an authoritative replay batch. Keep the
// old rendered snapshot until that batch arrives, then replace both in one
// reactive mutation. Clearing on the reset frame caused a visible white flash
// on every Codex rewrite/resume. If replay stalls, keep the last good snapshot:
// clearing it turned a transient mobile pause into a permanently blank chat.
interface PendingStreamReset {
  generation: number | null;
  mode: "merge" | "replace";
  commitTimer: ReturnType<typeof setTimeout> | null;
  fallbackTimer: ReturnType<typeof setTimeout>;
  items: Map<number, string>;
}

interface SessionSubscriptionState {
  generation: number;
  initialResetSeen: boolean;
}

interface TailFetchWork {
  requestId: number;
  priority: SessionTailPriority;
  startedAt: number;
  promise: Promise<void>;
}

const pendingStreamResets = new Map<string, PendingStreamReset>();
const sessionSubscriptions = new Map<string, SessionSubscriptionState>();
const subscriptionGenerations = new Map<string, number>();
const tailFetchWork = new Map<string, TailFetchWork>();
const tailFetchRequestIds = new Map<string, number>();
const tailFreshAt = new Map<string, number>();
const recentGapRepairWork = new Map<string, Promise<void>>();
const STREAM_RESET_SETTLE_MS = 250;
const STREAM_RESET_FALLBACK_MS = 5000;
const TAIL_FRESH_MS = 20_000;
// Foreground recovery first joins a healthy in-flight interactive fetch. If it
// is still unresolved by the later retry sweep, a fresh request supersedes it
// instead of letting one suspended/mobile request block every forced catch-up.
const FORCED_TAIL_SUPERSEDE_MS = 2_000;
// A suspended phone can miss hundreds of physical rollout records during one
// long tool-heavy Codex turn. A fixed tail-N snapshot then creates a sparse
// jump from the cached user prompt to the last few tool rows. Repair only that
// recent gap, bounded to one range response; ordinary contiguous opens still
// transfer the small 60-line tail.
const TAIL_GAP_REPAIR_LINES = 1_000;

function isCodexUserMessage(raw: string | undefined): boolean {
  return isCodexDurableUserMessage(raw);
}

function recentCodexGapStart(
  lines: readonly string[],
  fromIndex: number,
  loadedFromIndex: number | null,
): number | null {
  if (fromIndex <= 0) return null;
  const knownFloor = loadedFromIndex === null
    ? fromIndex
    : Math.min(fromIndex, Math.max(0, loadedFromIndex));
  const floor = Math.max(0, fromIndex - TAIL_GAP_REPAIR_LINES, knownFloor);
  let index = fromIndex - 1;
  for (; index >= floor; index--) {
    const raw = lines[index];
    if (!raw) break;
    // A complete current-turn anchor already exists in the contiguous cached
    // suffix, so an intentionally-unloaded older prefix is not a gap.
    if (isCodexUserMessage(raw)) return null;
  }
  if (index >= floor) {
    // Walk across the sparse hole to the last cached row. Returning the first
    // missing index avoids redownloading the old contiguous snapshot.
    while (index >= floor && !lines[index]) index--;
    return index + 1;
  }
  // A pure tail snapshot can be contiguous yet begin halfway through a very
  // long active turn. If it contains no user boundary, extend the window once
  // so the adapter can reconstruct that turn rather than showing tool scraps.
  return knownFloor > 0 ? Math.max(0, fromIndex - TAIL_GAP_REPAIR_LINES) : null;
}

function beginStreamReset(
  id: string,
  generation: number | null,
  mode: "merge" | "replace",
) {
  const previous = pendingStreamResets.get(id);
  if (previous?.commitTimer) clearTimeout(previous.commitTimer);
  if (previous) clearTimeout(previous.fallbackTimer);
  const fallbackTimer = setTimeout(() => {
    const current = pendingStreamResets.get(id);
    if (current?.generation === generation) pendingStreamResets.delete(id);
  }, STREAM_RESET_FALLBACK_MS);
  pendingStreamResets.set(id, {
    generation,
    mode,
    commitTimer: null,
    fallbackTimer,
    items: new Map(),
  });
}

function finishStreamReset(id: string): void {
  const pending = pendingStreamResets.get(id);
  if (!pending) return;
  if (pending.commitTimer) clearTimeout(pending.commitTimer);
  clearTimeout(pending.fallbackTimer);
  pendingStreamResets.delete(id);
  if (
    pending.generation !== null
    && sessionSubscriptions.get(id)?.generation !== pending.generation
  ) return;
  const items = [...pending.items.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, raw]) => ({ index, raw }));
  if (!items.length) return;
  const cache = useSessionCacheStore();
  const existing = cache.bySession[id]?.lines ?? [];
  const conflicts = items.some(({ index, raw }) => {
    return replayLineConflicts(existing[index], raw);
  });
  // A fresh subscription's first reset is a bounded tail snapshot, not proof
  // that the cached prefix is stale. Merge it unless the overlap itself proves
  // a rewrite. Later resets on the same subscription are authoritative file
  // rewrites and replace the snapshot atomically.
  if (pending.mode === "merge" && !conflicts) cache.appendBatch(id, items);
  else cache.replaceBatch(id, items);
}

function stageStreamReset(
  id: string,
  generation: number | null,
  items: readonly { index: number; raw: string }[],
): boolean {
  const pending = pendingStreamResets.get(id);
  if (!pending || pending.generation !== generation) return false;
  for (const item of items) pending.items.set(item.index, item.raw);
  if (pending.commitTimer) clearTimeout(pending.commitTimer);
  pending.commitTimer = setTimeout(() => finishStreamReset(id), STREAM_RESET_SETTLE_MS);
  return true;
}

function cancelStreamReset(id: string): boolean {
  const pending = pendingStreamResets.get(id);
  if (!pending) return false;
  if (pending.commitTimer) clearTimeout(pending.commitTimer);
  clearTimeout(pending.fallbackTimer);
  pendingStreamResets.delete(id);
  return true;
}

// [perf] diagnostic: engage() timestamp per session, consumed once when the
// first stream-batch lands so we can split click→data (WS+backend) from
// data→painted (render). Remove later.
const perfEngageAt = new Map<string, number>();

// Persisted high-water mark of the highest notification seq the frontend has
// processed. Sent back to the backend on subscribe so it can replay anything
// we missed during a brief disconnect (page refresh, sleep, network blip).
const NOTIF_SEQ_KEY = "cw:lastNotifSeq:v1";
const ENGAGE_TAIL_N = 200;
// Keep the on-tap/foreground HTTP catch-up deliberately tiny. Real-world
// Codex tails can put hundreds of KiB into just 60 physical records; over the
// phone's Tailnet relay that kept the user-facing “同步最新” state open even
// though only the newest reply was needed. The WS subscribe still replays 200
// records, background warming keeps 200, and a missing current-turn anchor is
// repaired asynchronously through the compact range endpoint.
const ENGAGE_HTTP_TAIL_N = 20;
const PREFETCH_TAIL_N = 200;
// How many of the most-recent sessions to keep warm via background tail
// prefetch. Recency-ordered (sessions.list is mtime-desc).
const PREFETCH_LIMIT = 8;
// With a very large archive, speculative cold indexes monopolize disk for
// minutes and make the chat the user actually taps wait behind them. The local
// IDB restore below is still useful; only the network/disk prefetch is skipped.
const MAX_NETWORK_PREFETCH_SESSION_COUNT = 200;
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
    tailErrors: {},
    turnProgress: {},
  }),
  actions: {
    observeTurnProgressLine(id: string, raw: string, sourceIndex?: number) {
      const event = codexRuntimeProgressEvent(raw);
      if (!event) return;
      if (event.type === "start") {
        activeToolLabels.delete(id);
        this.turnProgress[id] = "Codex is working…";
        const sessions = useSessionsStore();
        sessions.setStatus(id, "running", true, false);
        if (event.timestamp) sessions.setBoundaryAt(id, event.timestamp);
        const item = sessions.byId[id];
        if (item && event.preview) {
          item.preview = event.preview;
          item.previewRole = "user";
          if (event.timestamp) item.lastTurnAt = event.timestamp;
        }
        return;
      }
      if (event.type === "assistant") {
        const item = useSessionsStore().byId[id];
        if (item && event.preview) {
          item.preview = event.preview;
          item.previewRole = "assistant";
          if (event.timestamp) item.lastTurnAt = event.timestamp;
        }
        return;
      }
      if (event.type === "terminal") {
        const sessions = useSessionsStore();
        sessions.setStatus(id, "exited", false, false);
        if (event.timestamp) sessions.setBoundaryAt(id, event.timestamp);
        usePromptPendingStore().settleDispatched(id, {
          ...(typeof sourceIndex === "number" ? { sourceIndex } : {}),
          ...(event.timestamp ? { timestamp: event.timestamp } : {}),
        });
        delete this.turnProgress[id];
        activeToolLabels.delete(id);
        return;
      }
      if (event.type === "compaction-complete") {
        // The durable record repairs a missed realtime `compacting:false`
        // push without changing the surrounding turn's running state.
        useSessionsStore().setCompacting(id, false);
        return;
      }
      if (event.type === "tool-start") {
        const labels = activeToolLabels.get(id) ?? new Map<string, string>();
        labels.set(event.callId, event.label);
        activeToolLabels.set(id, labels);
        this.turnProgress[id] = event.label;
        return;
      }
      const labels = activeToolLabels.get(id);
      labels?.delete(event.callId);
      // A completed tool is already visible as a settled card in the
      // transcript. Keeping "Completed · exec" in the live status strip made
      // an otherwise healthy turn look frozen between tool calls. If another
      // concurrent tool remains, keep showing that one; otherwise return to
      // the honest generic running state until the next observable activity.
      const remaining = labels && labels.size > 0
        ? Array.from(labels.values()).at(-1)
        : undefined;
      if (!remaining) activeToolLabels.delete(id);
      this.turnProgress[id] = remaining ?? "Codex is working…";
    },
    scheduleViewedTranscriptRepair(id: string) {
      const previous = viewedTranscriptRepairTimers.get(id);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        viewedTranscriptRepairTimers.delete(id);
        if (useUiStore().selectedSessionId !== id) return;
        // If the session was opened while the turn completed, its initial tail
        // request may have captured the pre-reply file. Let that request settle,
        // then force a second read instead of coalescing onto the stale snapshot.
        const initialFetch = tailFetchWork.get(id)?.promise;
        void (async () => {
          if (initialFetch) await initialFetch.catch(() => undefined);
          if (useUiStore().selectedSessionId !== id) return;
          await this.refreshSession(id, true);
        })().catch((error) => {
          console.warn(`[live] viewed transcript repair failed for ${id}: ${(error as Error).message}`);
        });
      }, VIEWED_TRANSCRIPT_REPAIR_MS);
      viewedTranscriptRepairTimers.set(id, timer);
    },
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
          previewRole: (msg.previewRole === "user" || msg.previewRole === "assistant") ? msg.previewRole : null,
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
          // Snapshot the visible-message metadata before addOrTouch mutates the
          // reactive row in place. A file append can legitimately repeat the
          // previous assistant preview (for example while the user's next
          // prompt is only a queue record); that is activity, not a new reply.
          const previousPreview = cur.preview ?? null;
          const previousPreviewRole = cur.previewRole ?? null;
          const previousLastTurnAt = cur.lastTurnAt ?? null;
          // Merge in the freshly-extracted preview so the sidebar row reflects
          // the latest turn without waiting for a full listSessions refresh.
          // Falls back to the existing preview if the event didn't carry one
          // (e.g. tail had no qualifying user/assistant text record).
          const newPreview = (msg.preview as string | null | undefined);
          const newPreviewRole = msg.previewRole === "user" || msg.previewRole === "assistant"
            ? msg.previewRole
            : null;
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
            previewRole: newPreview ? newPreviewRole : (cur.previewRole ?? null),
            lastTurnAt: newLastTurnAt ?? (msg.mtime as string),
          };
          sessions.addOrTouch(merged);

          const row = sessions.byId[id];
          const selectedSessionId = useUiStore().selectedSessionId;
          const isSelected = id === selectedSessionId;
          const isActivelyViewed = isSessionActivelyViewed(id, selectedSessionId);
          const assistantPreviewAdvanced = !!newPreview
            && newPreviewRole === "assistant"
            // Ignore a stale/out-of-order event that addOrTouch rejected.
            && row?.previewRole === "assistant"
            && row.preview === newPreview
            && (
              previousPreviewRole !== "assistant"
              || previousPreview !== newPreview
              || isNewerTurnTimestamp(row.lastTurnAt, previousLastTurnAt)
            );

          // Keep the selected transcript warm even when the installed app is
          // behind another window, so it is current when the user returns.
          if (isSelected && assistantPreviewAdvanced) {
            this.scheduleViewedTranscriptRepair(id);
          }

          if (isActivelyViewed) {
            // Prevent a transient selection/promotion race from leaving a
            // badge on the conversation the user is actually seeing. Merely
            // skipping the next bump is insufficient if an earlier preview
            // already added one.
            if (newPreviewRole === "user") {
              sessions.markReadAt(id, row?.lastTurnAt || row?.mtime || (msg.mtime as string));
            } else {
              sessions.markReadLocal(id);
            }
            earlyAssistantUnread.delete(id);
          } else if (newPreviewRole === "user" && row?.previewRole === "user") {
            // A user-authored turn is itself proof that this conversation was
            // read, even if a mobile history/promotion race briefly changed
            // the selected id. Only act after addOrTouch accepted that user
            // turn: an older, out-of-order user event must not clear the unread
            // badge (or guard) for a newer assistant reply.
            earlyAssistantUnread.delete(id);
            sessions.markReadAt(id, row?.lastTurnAt || row?.mtime || (msg.mtime as string));
          } else if (
            assistantPreviewAdvanced
            && !earlyAssistantUnread.has(id)
          ) {
            const prefs = usePrefsStore();
            if (shouldNotifyForSession({
              id,
              peer: msg.peer === true || cur.peer === true,
              subagent: msg.subagent === true || cur.subagent === true,
            }, prefs)) {
              sessions.bumpUnread(id);
              earlyAssistantUnread.add(id);
            }
          }
        }
        // Desync watchdog — see staleStreamTimers comment at module top.
        // Only arm if (a) we're engaged on this session and (b) no timer
        // is already pending (multiple touched events should not stack).
        if (this.perSession[id] && !staleStreamTimers.has(id)) {
          const t = setTimeout(() => {
            staleStreamTimers.delete(id);
            if (!this.perSession[id]) return;
            const now = Date.now();
            if (now - (staleStreamHttpAt.get(id) ?? 0) < STALE_STREAM_HTTP_MIN_GAP_MS) return;
            staleStreamHttpAt.set(id, now);
            console.warn(
              `[live] session ${id} desynced (touched without stream); ` +
              "fetching an HTTP ground-truth tail",
            );
            // Do not tear down a possibly-healthy tail here. The old
            // unsubscribe/subscribe recovery raced the backend's async tailer
            // startup and could leave the session with no stream at all.
            // Every future session-touched event can cheaply repeat this HTTP
            // fallback while the socket heals on its own.
            void this.refreshSession(id, true).catch((error) => {
              console.warn(`[live] watchdog tail fetch failed for ${id}: ${(error as Error).message}`);
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
            if (!row.readAt || isNewerTurnTimestamp(at, row.readAt)) row.readAt = at;
            const unreadCount = msg.unreadCount;
            if (Number.isSafeInteger(unreadCount) && Number(unreadCount) >= 0) {
              sessions.setUnread(id, Number(unreadCount));
            } else {
              sessions.reconcileRead(row);
            }
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
        if (newStatus !== "running") {
          delete this.turnProgress[id];
          activeToolLabels.delete(id);
        }
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
        // A reply is already read only when its conversation is selected AND
        // this window is visible and focused. An installed PWA can stay alive
        // while minimized or behind another app; that case must still produce
        // an unread badge and (with permission) an OS notification.
        const id = msg.id as string;
        const ui = useUiStore();
        // Completion notifications carry the final visible reply in `body`.
        // Persist it into the row before any foreground/unread early return so
        // a finished turn cannot fall back to the user's previous prompt.
        const body = typeof msg.body === "string" ? msg.body : "";
        const preview = compactSidebarPreview(body);
        const item = sessions.byId[id];
        const notificationAt = typeof msg.timestamp === "string" ? msg.timestamp : null;
        const alreadyRead = timestampCovers(item?.readAt, notificationAt);
        const supersededByNewerTurn = !!notificationAt
          && isNewerTurnTimestamp(item?.lastTurnAt, notificationAt);
        const isSelected = id === ui.selectedSessionId;
        const isActivelyViewed = isSessionActivelyViewed(id, ui.selectedSessionId);
        if (
          isSelected
          && !supersededByNewerTurn
          && preview
          && preview !== "Turn completed"
        ) {
          this.scheduleViewedTranscriptRepair(id);
        }
        if (alreadyRead || supersededByNewerTurn) {
          // A delayed end-turn from before the user's next outbound message is
          // not a new reply. Do not overwrite the newer sidebar preview, bump
          // unread, or consume the early-unread guard for a genuinely newer
          // assistant turn.
          if (item) sessions.reconcileRead(item);
          return;
        }
        if (item && preview && preview !== "Turn completed") {
          item.preview = preview;
          item.previewRole = "assistant";
          const at = typeof msg.timestamp === "string" ? msg.timestamp : "";
          if (at) item.lastTurnAt = at;
        }
        if (isActivelyViewed) {
          earlyAssistantUnread.delete(id);
          // Clear locally in the same event turn. Waiting for our own
          // mark-read broadcast lets a wrongly-early preview badge flash (and
          // leaves it stuck if that best-effort RPC fails).
          sessions.markReadLocal(id);
          // A reply landed while you're actively viewing this session on THIS
          // device. It's read here, so advance the cross-device watermark too —
          // otherwise the other devices keep showing it unread. Best-effort:
          // uses the freshly-arrived timestamp (falls back to the row's).
          const at = (msg.timestamp as string | undefined) || item?.lastTurnAt || item?.mtime;
          if (at) sessions.markReadAt(id, at);
          return;
        }
        const authoritativeUnread = Number.isSafeInteger(msg.unreadCount) && Number(msg.unreadCount) >= 0
          ? Number(msg.unreadCount)
          : null;
        if (authoritativeUnread !== null) {
          earlyAssistantUnread.delete(id);
          sessions.setUnread(id, authoritativeUnread);
          // The server may have processed a monotonic read watermark before a
          // delayed completion replay reached this client. Do not resurrect an
          // OS notification when the canonical unread count is already zero.
          if (authoritativeUnread === 0) return;
        }
        const prefs = usePrefsStore();
        if (!shouldNotifyForSession({
          id,
          peer: msg.peer === true || item?.peer === true,
          subagent: msg.subagent === true || item?.subagent === true,
        }, prefs)) return;
        if (authoritativeUnread === null) {
          if (earlyAssistantUnread.has(id)) earlyAssistantUnread.delete(id);
          else sessions.bumpUnread(id);
        }
        // Unread state remains visible in the sidebar and synchronized through
        // the server watermark. Reply-completion popups are intentionally
        // disabled on every device.
      }
    },
    subscribeToSession(id: string, from: number, tailN = ENGAGE_TAIL_N): number {
      const generation = (subscriptionGenerations.get(id) ?? 0) + 1;
      subscriptionGenerations.set(id, generation);
      sessionSubscriptions.set(id, { generation, initialResetSeen: false });
      const params: Record<string, unknown> = {
        sessionId: id,
        from,
        tailN,
        // Newer backends echo this opaque value on every session frame. The
        // local generation guard still protects callbacks retained by the WS
        // layer; the echoed value also rejects a late frame emitted by an old
        // backend tailer after unsubscribe.
        subscriptionGeneration: generation,
      };
      this.perSession[id] = subscribe("session", params, (msg) => {
        const wireGeneration = msg.subscriptionGeneration;
        if (typeof wireGeneration === "number" && wireGeneration !== generation) return;
        if (sessionSubscriptions.get(id)?.generation !== generation) return;
        this.onSessionMsg(id, msg, generation);
      });
      return generation;
    },
    async engage(id: string) {
      if (this.perSession[id]) return;
      perfEngageAt.set(id, performance.now()); // [perf] click→data/render split
      const cache = useSessionCacheStore();
      // IMPORTANT: do NOT await cache.restore here. Loading the cached
      // lines from IDB and letting Vue re-derive `timeline` / `decorated`
      // over them is the dominant page-open stall — multi-second on long
      // sessions ("10s 才到底" feedback). Start it first without
      // blocking so a warm IDB snapshot gets a head start and can paint while
      // offline; WS + HTTP begin immediately afterwards and reconcile it.
      void cache.restore(id);
      //
      // Pass from=0 because the backend's tail mode (tailN=200) reads
      // ~200 KB from EOF backwards regardless of `from` — passing the
      // cached nextLineIndex would just risk a race where restore lands
      // BEFORE the WS subscribe and we miss tail lines. Always-from-0 +
      // tail mode is the cheapest correct path.
      this.subscribeToSession(id, 0, ENGAGE_TAIL_N);
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
      void this.refreshSession(id)
        .catch((err) => console.warn(`[live] HTTP tail prefetch failed for ${id}: ${(err as Error).message}`))
        .finally(() => undefined);
    },
    /**
     * Synchronize one session over HTTP without rebuilding its live WS tail.
     * Same-priority callers share one request; an interactive open may
     * supersede speculative background warming. Successful snapshots stay
     * fresh briefly so tap + focus events do not download the same tail twice.
     * `force` bypasses freshness and may supersede interactive work that has
     * already outlived the healthy foreground-response budget.
     */
    refreshSession(id: string, force = false): Promise<void> {
      return this.fetchTailIntoCache(id, ENGAGE_HTTP_TAIL_N, force, "interactive");
    },
    // Quietly reconcile a selected turn that still looks active. Unlike the
    // normal foreground refresh this does not flash the user-facing syncing
    // pill; durable user/assistant/terminal records repair both the sidebar
    // preview and a missed session-status push.
    reconcileRunningSession(id: string): Promise<void> {
      return this.fetchTailIntoCache(id, ENGAGE_HTTP_TAIL_N, true, "interactive", false);
    },
    async fetchTailIntoCache(
      id: string,
      n: number,
      force = false,
      priority: SessionTailPriority = "interactive",
      showFetching = true,
    ): Promise<void> {
      const now = Date.now();
      const existing = tailFetchWork.get(id);
      // A tap/open must not inherit the latency of a speculative 200-line
      // background warm-up. Supersede it with a small interactive request.
      // The request id guard below prevents the older response rolling back
      // the cache. Same-priority callers normally coalesce, but a forced
      // foreground retry must be able to escape a request frozen by the OS.
      if (existing) {
        const joinsExisting = existing.priority === "interactive" || priority === "background";
        const supersedeStaleInteractive = force
          && priority === "interactive"
          && existing.priority === "interactive"
          && now - existing.startedAt >= FORCED_TAIL_SUPERSEDE_MS;
        if (joinsExisting && !supersedeStaleInteractive) return existing.promise;
      }
      if (!force && now - (tailFreshAt.get(id) ?? 0) < TAIL_FRESH_MS) {
        return;
      }

      const requestId = (tailFetchRequestIds.get(id) ?? 0) + 1;
      tailFetchRequestIds.set(id, requestId);
      if (showFetching) {
        this.tailFetching[id] = true;
        this.tailErrors[id] = undefined;
      }

      let promise!: Promise<void>;
      promise = (async () => {
        const cache = useSessionCacheStore();
        const tail = await readSessionTail(id, n, priority);
        // A superseding request (future cancellation/retry paths) owns the
        // cache and UI state. Never let an older response roll it back.
        if (tailFetchRequestIds.get(id) !== requestId) return;

        const items = tail.lines
          .filter((l) => typeof l?.index === "number" && Number.isFinite(l.index) && typeof l?.raw === "string")
          .map((l) => ({ index: l.index, raw: l.raw }));
        const entry = cache.ensure(id);
        const shrank = tail.totalLines < entry.nextLineIndex;
        const conflicts = items.some(({ index, raw }) => {
          return replayLineConflicts(entry.lines[index], raw);
        });
        const coverageFrom = Number.isFinite(tail.fromIndex)
          ? Math.max(0, Math.floor(tail.fromIndex))
          : (items[0]?.index ?? tail.totalLines);
        const sessionAgent = useSessionsStore().byId[id]?.agent;
        const tailHasUserAnchor = items.some((item) => isCodexUserMessage(item.raw));
        const gapRepairFrom = sessionAgent === "codex" && !tailHasUserAnchor && !shrank && !conflicts
          ? recentCodexGapStart(entry.lines, coverageFrom, entry.loadedFromIndex)
          : null;

        if (items.length > 0) {
          // Cache warming also repairs sidebar previews for recently completed
          // background turns. Without observing these lines, a reload could keep
          // showing the user's prompt even though the assistant reply is already
          // present in the fetched tail.
          for (const item of items) this.observeTurnProgressLine(id, item.raw, item.index);
          // Same-index disagreement or a shorter physical source proves that
          // append-only merge is unsafe (rewind/fork/rewrite). The bounded tail
          // becomes the new authoritative window; older history remains marked
          // as unloaded and can be fetched on demand.
          if (shrank || conflicts) cache.replaceBatch(id, items);
          else cache.appendBatch(id, items);
        } else if (shrank) {
          // An empty/fully-filtered shorter transcript still has authoritative
          // physical length. Do not leave deleted cached suffix rows visible.
          cache.truncateTo(id, tail.totalLines);
        }

        // session-cache owns the distinction between visible content and the
        // physical range already examined.
        cache.markLoadedFrom(id, coverageFrom);
        // totalLines includes filtered Claude bookkeeping records. Preserve the
        // physical high-water without allocating sparse placeholders.
        cache.advanceCursor(id, tail.totalLines);

        if (
          tail.supportsCompactRange === true
          && gapRepairFrom !== null
          && gapRepairFrom < coverageFrom
        ) {
          // The latest tail is already merged and usable. Repair the sparse
          // middle quietly with the server's strict compact budget instead of
          // holding the user-facing "syncing latest" state open for a second,
          // potentially multi-megabyte request. Older servers do not advertise
          // this capability, so a frontend-only deploy safely skips the repair
          // rather than sending their unbounded legacy range request.
          void this.repairRecentGap(id, gapRepairFrom, coverageFrom, requestId);
        }
        tailFreshAt.set(id, Date.now());
      })()
        .catch((error) => {
          if (showFetching && tailFetchRequestIds.get(id) === requestId) {
            this.tailErrors[id] = error instanceof Error ? error.message : String(error);
          }
          throw error;
        })
        .finally(() => {
          if (tailFetchWork.get(id)?.requestId !== requestId) return;
          tailFetchWork.delete(id);
          if (showFetching) this.tailFetching[id] = false;
        });

      tailFetchWork.set(id, { requestId, priority, startedAt: now, promise });
      return promise;
    },
    repairRecentGap(id: string, from: number, to: number, tailRequestId: number): Promise<void> {
      const existing = recentGapRepairWork.get(id);
      if (existing) return existing;
      const work = (async () => {
        const bridge = await readSessionRange(id, from, to, { mode: "compact" });
        // A newer tail may represent a truncate/rewrite. Its authoritative
        // request owns empty slots, so never let an older bridge refill them.
        if (tailFetchRequestIds.get(id) !== tailRequestId) return;
        const bridgeItems = bridge.lines
          .filter((line) => (
            typeof line?.index === "number"
            && Number.isFinite(line.index)
            && typeof line?.raw === "string"
          ))
          .map((line) => ({ index: line.index, raw: line.raw }));
        const cache = useSessionCacheStore();
        if (bridgeItems.length) {
          for (const item of bridgeItems) this.observeTurnProgressLine(id, item.raw, item.index);
          cache.appendBatch(id, bridgeItems);
        }
        // Compact reads are byte-capped and may return only a suffix. Record
        // only the first physical row actually received, never claim an unseen
        // prefix as loaded.
        cache.markLoadedFrom(id, bridgeItems[0]?.index ?? to);
      })()
        .catch((error) => {
          // Latest content already succeeded. A best-effort history bridge
          // must not replace that with a scary/retryable sync failure.
          console.warn(`[live] compact gap repair failed for ${id}: ${(error as Error).message}`);
        })
        .finally(() => {
          if (recentGapRepairWork.get(id) === work) recentGapRepairWork.delete(id);
        });
      recentGapRepairWork.set(id, work);
      return work;
    },
    // Warm the cache for the most-recently-active sessions so tapping one
    // renders instantly from cache instead of waiting on the on-tap fetch.
    // Fired on boot, reconnect, and resume. Coalesce overlapping recovery
    // sweeps and keep a short freshness window so one wake-up burst cannot
    // download the same recent 8 MiB-bounded tails repeatedly.
    async prefetchTails(limit = PREFETCH_LIMIT) {
      if (prefetchWork) return prefetchWork;
      const sessions = useSessionsStore();
      const ids = sessions.list
        .filter((s) => !s.id.startsWith("draft:"))
        .slice(0, limit)
        .map((s) => s.id)
        // The engaged session fetches its own fresh tail in engage().
        .filter((id) => !this.perSession[id]);
      if (!ids.length) return;
      const cache = useSessionCacheStore();
      // Give local snapshots the same head start as an explicit engage. The
      // restore store coalesces duplicates, while network warming proceeds in
      // parallel and remains independently freshness-gated below.
      for (const id of ids) void cache.restore(id);
      if (sessions.list.length > MAX_NETWORK_PREFETCH_SESSION_COUNT) return;
      let work!: Promise<void>;
      work = (async () => {
        // Cold JSONL indexing is intentionally serialized by the backend.
        // Queueing every recent session at once only puts a future user tap
        // behind speculative archive work, so warm them quietly one at a time.
        for (const id of ids) {
          await this.fetchTailIntoCache(id, PREFETCH_TAIL_N, false, "background")
            .catch(() => undefined);
        }
      })()
        .finally(() => {
          if (prefetchWork === work) prefetchWork = null;
        });
      prefetchWork = work;
      return work;
    },
    disengage(id: string) {
      // Invalidate the callback before asking the transport to unsubscribe.
      // A tailer already inside an async disk read may emit one final batch.
      sessionSubscriptions.delete(id);
      cancelStreamReset(id);
      const unsub = this.perSession[id];
      if (unsub) {
        unsub();
        delete this.perSession[id];
      }
      clearStaleStreamTimer(id);
      const repair = viewedTranscriptRepairTimers.get(id);
      if (repair) {
        clearTimeout(repair);
        viewedTranscriptRepairTimers.delete(id);
      }
    },
    async resetAndReengage(id: string) {
      this.disengage(id);
      const cache = useSessionCacheStore();
      await cache.clear(id);
      await this.engage(id);
    },
    // Recover engaged sessions over HTTP without an unsubscribe/subscribe
    // burst. ws.ts already restores its subscription after a reconnect; a
    // second rebuild here raced that automatic replay and could leave the
    // backend with no tail. HTTP is also the reliable path for an OPEN-but-
    // zombie mobile socket.
    async refreshEngaged(force = false): Promise<boolean> {
      const ids = Object.keys(this.perSession);
      let succeeded = true;
      await Promise.all(ids.map(async (id) => {
        // The WS layer may have just auto-recreated its backend tail. Its next
        // reset is therefore an initial bounded replay and must merge with the
        // cached prefix. If this was only a healthy visibility wake, conflict
        // detection still promotes a genuine later rewrite to replacement.
        const subscription = sessionSubscriptions.get(id);
        if (subscription) subscription.initialResetSeen = false;
        await this.refreshSession(id, force).catch((error) => {
          succeeded = false;
          console.warn(`[live] recovery tail fetch failed for ${id}: ${(error as Error).message}`);
        });
      }));
      return succeeded;
    },
    onSessionMsg(id: string, msg: Record<string, unknown>, generation: number | null = null) {
      if (
        generation !== null
        && sessionSubscriptions.get(id)?.generation !== generation
      ) return;
      const type = msg.type as string;

      if (type === "stream-reset") {
        let mode: "merge" | "replace" = "replace";
        if (generation !== null) {
          const subscription = sessionSubscriptions.get(id);
          if (subscription && !subscription.initialResetSeen) {
            subscription.initialResetSeen = true;
            mode = "merge";
          }
        }
        console.log(`[live] stream-reset for session=${id} — staging ${mode} replay`);
        beginStreamReset(id, generation, mode);
        return;
      }
      if (type === "stream-truncate") {
        cancelStreamReset(id);
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
        // Newer backends use cursor as an explicit replay-complete marker.
        // On older backends this is still safe: initial replay finishes before
        // the watcher can emit a cursor for appended/filtered records.
        const pending = pendingStreamResets.get(id);
        if (pending?.generation === generation) finishStreamReset(id);
        const cache = useSessionCacheStore();
        cache.advanceCursor(id, nextIndex);
        return;
      }

      if (type === "stream-line") {
        const idx = msg.index as number;
        const data = msg.data as string;
        if (typeof idx !== "number" || !Number.isFinite(idx) || typeof data !== "string") return;
        clearStaleStreamTimer(id);
        this.observeTurnProgressLine(id, data, idx);
        const cache = useSessionCacheStore();
        if (stageStreamReset(id, generation, [{ index: idx, raw: data }])) return;
        else cache.appendLine(id, idx, data);
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
        clearStaleStreamTimer(id);
        for (const item of items) this.observeTurnProgressLine(id, item.raw, item.index);
        const cache = useSessionCacheStore();
        if (stageStreamReset(id, generation, items)) return;
        else cache.appendBatch(id, items);
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
      sessionSubscriptions.clear();
      for (const id of tailFetchWork.keys()) {
        tailFetchRequestIds.set(id, (tailFetchRequestIds.get(id) ?? 0) + 1);
      }
      tailFetchWork.clear();
      for (const id of recentGapRepairWork.keys()) {
        tailFetchRequestIds.set(id, (tailFetchRequestIds.get(id) ?? 0) + 1);
      }
      recentGapRepairWork.clear();
      this.tailFetching = {};
      this.tailErrors = {};
      this.turnProgress = {};
      activeToolLabels.clear();
      for (const t of staleStreamTimers.values()) clearTimeout(t);
      staleStreamTimers.clear();
      staleStreamHttpAt.clear();
      for (const timer of viewedTranscriptRepairTimers.values()) clearTimeout(timer);
      viewedTranscriptRepairTimers.clear();
      for (const pending of pendingStreamResets.values()) {
        if (pending.commitTimer) clearTimeout(pending.commitTimer);
        clearTimeout(pending.fallbackTimer);
      }
      pendingStreamResets.clear();
    },
  },
});
