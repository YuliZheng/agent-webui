<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";
import { useSessionCacheStore } from "../stores/session-cache.js";
import { useSessionsStore } from "../stores/sessions.js";
import { usePromptPendingStore, type PendingPrompt } from "../stores/prompt-pending.js";
import { useDraftsStore } from "../stores/drafts.js";
import { useScrollTargetStore } from "../stores/scroll-target.js";
import { useSearchHighlightStore } from "../stores/search-highlight.js";
import { usePrefsStore } from "../stores/prefs.js";
import { useLocalFileViewerStore } from "../stores/local-file-viewer.js";
import { useLightboxStore } from "../stores/lightbox.js";
import { useUiStore } from "../stores/ui.js";
import { useLiveStore } from "../stores/live.js";
import { usePendingInteractionsStore } from "../stores/pending-interactions.js";
import { basenameFromPath, codexImageUrl, localFileFromHref } from "../util/local-file-links.js";
import { copyText } from "../util/clipboard.js";
import { extractAttachedImages } from "../util/extract-images.js";
import { standaloneExternalNavigationHref } from "../util/pwa-history.js";
import {
  matchedCodexPendingPromptIds,
  pendingPromptProbeRange,
} from "../util/pending-prompt-reconciliation.js";
import { useNotificationsStore } from "../stores/notifications.js";
import { groupTimeline, type TimelineNode, type ToolPair } from "../parser/group.js";
import { toolSummary } from "../parser/tool-summaries.js";
import { codexRolloutToClaudeLines } from "../parser/codex-adapt.js";
import { isTaskNotificationContent, parseTaskNotification, type TaskNotificationInfo } from "../parser/task-notification.js";
import { isQueueOperation } from "@claude-webui/shared/discriminate";
import { readSessionRange, sendPrompt, stopSession } from "../api/sessions.js";
import { revealLocalPath } from "../api/local-files.js";
import { wake as wsWake } from "../api/ws.js";

import UserPromptBlock from "./blocks/UserPromptBlock.vue";
import UserToolResultBlock from "./blocks/UserToolResultBlock.vue";
import UserCompactSummaryBlock from "./blocks/UserCompactSummaryBlock.vue";
import TaskNotificationBlock from "./blocks/TaskNotificationBlock.vue";
import AssistantBlock from "./blocks/AssistantBlock.vue";
import AssistantApiErrorBlock from "./blocks/AssistantApiErrorBlock.vue";
import TurnDurationBlock from "./blocks/system/TurnDurationBlock.vue";
import AwaySummaryBlock from "./blocks/system/AwaySummaryBlock.vue";
import LocalCommandBlock from "./blocks/system/LocalCommandBlock.vue";
import ApiErrorBlock from "./blocks/system/ApiErrorBlock.vue";
import CompactBoundaryBlock from "./blocks/system/CompactBoundaryBlock.vue";
import ToolRunBlock, { type ToolRunItem } from "./blocks/tool/ToolRunBlock.vue";
import AgentBadge from "./AgentBadge.vue";
import UserAvatar from "./UserAvatar.vue";
import AvatarEditorModal from "./AvatarEditorModal.vue";

interface Usage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
type DecoratedEntry = { node: TimelineNode; usage: Usage | null };
type RenderRow =
  | { kind: "entry"; entry: DecoratedEntry }
  | { kind: "toolRun"; key: string; items: ToolRunItem[] };

const props = defineProps<{ sessionId: string }>();
const cache = useSessionCacheStore();
const sessions = useSessionsStore();
const promptPending = usePromptPendingStore();
const drafts = useDraftsStore();
const scrollTarget = useScrollTargetStore();
const searchHighlight = useSearchHighlightStore();
const prefs = usePrefsStore();
const localFileViewer = useLocalFileViewerStore();
const lightbox = useLightboxStore();
const ui = useUiStore();
const live = useLiveStore();
const pendingInteractions = usePendingInteractionsStore();
// True while the on-tap HTTP tail fetch for this session is in flight — drives
// a small "syncing latest…" pill so the ~1s mobile/proxy round-trip reads
// as "loading" rather than a frozen/stale screen.
const syncingLatest = computed(() => !!live.tailFetching[props.sessionId]);
const scroller = ref<HTMLDivElement | null>(null);
const pendingPromptEl = ref<HTMLDivElement | null>(null);
const lockedToBottom = ref(true);

const running = computed(() => sessions.statusBySession[props.sessionId] === "running");
// CLI is mid-/compact. The jsonl is silent for the whole compact window
// (minutes on a big context), so without this wire-driven flag the UI shows
// nothing and the session looks stuck. Swaps the thinking label/banner.
const compacting = computed(() => !!sessions.compactingBySession[props.sessionId]);

const lines = computed(() => cache.bySession[props.sessionId]?.lines ?? []);
// Codex sessions stream app-server events; adapt them to claude-shaped records
// so the existing timeline/blocks render them. claude sessions pass through.
const isCodex = computed(() => sessions.byId[props.sessionId]?.agent === "codex");
const agent = computed(() => sessions.byId[props.sessionId]?.agent ?? "claude");
const renderLines = computed(() => isCodex.value ? codexRolloutToClaudeLines(lines.value) : lines.value);
const timeline = computed<TimelineNode[]>(() => groupTimeline(renderLines.value));
const pendingPrompts = computed(() => promptPending.pending(props.sessionId));
const pendingProbeAttempted = new Set<string>();
// Do not wait for Codex's potentially slow thread/resume before acknowledging
// activity. Once WebSocket.send succeeds, show the local thinking indicator
// immediately; the authoritative backend running push takes over before the
// prompt RPC resolves. Accepted steers are excluded because they can remain as
// durable local chips after the active turn has ended.
const optimisticallyStarting = computed(() =>
  pendingPrompts.value.some(prompt => prompt.phase === "dispatched"),
);
// Backend-queue chips. Walks the jsonl tail backwards from EOF until it
// hits a clearing event (`assistant`, queue-op remove/dequeue), collecting
// queue-op enqueue records along the way. `assistant` as a clearing event
// is the defensive fallback for a missed remove on a degraded transport.
// Capped at the last CHIP_SCAN_WINDOW lines so a long session with no
// matching clearing event ever (eg. truncated tail) doesn't trigger a
// full-history walk on every cache mutation.
const CHIP_SCAN_WINDOW = 500;
// `task` is set when the enqueued content is a `<task-notification>` blob (a
// background task that settled while claude was mid-turn). The CLI queues it
// like any other command, but its raw XML would render as an ugly wall of
// tags — so we parse it into the same compact summary TaskNotificationBlock
// shows on the timeline once it's consumed.
type QueueChip = { uuid: string; content: string; task: TaskNotificationInfo | null };
const queueChips = computed<QueueChip[]>(() => {
  const out: QueueChip[] = [];
  const end = lines.value.length;
  const stop = Math.max(0, end - CHIP_SCAN_WINDOW);
  for (let i = end - 1; i >= stop; i--) {
    const ln = lines.value[i];
    if (!ln) continue;
    if (ln.indexOf('"queue-operation"') < 0) continue;
    let r: unknown;
    try { r = JSON.parse(ln); } catch { continue; }
    if (!isQueueOperation(r as Record<string, unknown>)) continue;
    const op = (r as { operation: string }).operation;
    // Only a consume op marks the boundary. An assistant line does NOT — a
    // prompt queued mid-turn keeps streaming the *current* turn's assistant
    // lines while it's still pending, so breaking on assistant would hide the
    // chip the instant the reply continues. The matching remove/dequeue is
    // always more recent than its enqueue, so it's scanned first and clears
    // the chip correctly once the prompt is actually consumed.
    if (op === "remove" || op === "dequeue" || op === "popAll") break;
    const content = (r as { content?: unknown }).content as string ?? "";
    out.unshift({
      uuid: typeof (r as { uuid?: unknown }).uuid === "string" ? (r as { uuid: string }).uuid : `qe-${i}`,
      content,
      task: isTaskNotificationContent(content) ? parseTaskNotification(content) : null,
    });
  }
  return out;
});
// Reconcile the optimistic pending bubbles against what's actually landed,
// removing entries whose real record has arrived. Driven by the lines watch
// below (also `immediate`, so it runs on mount — i.e. after a refresh restores
// the persisted entries from localStorage).
//
//   - claude: clear once the session grew past the entry's send-time line
//     count — the real user line / queue chip has landed and taken over.
//   - codex: clear only when a matching real user_message appears in the
//     rollout (matched by text, oldest-first). A steered message that codex
//     never echoes finds no match and stays — it IS the durable record.
function reconcilePendingPrompts() {
  const entries = promptPending.pending(props.sessionId);
  if (!entries.length) return;
  if (isCodex.value) {
    for (const id of matchedCodexPendingPromptIds(lines.value, entries)) {
      promptPending.remove(props.sessionId, id);
    }
    // A persisted optimistic entry can outlive the normal 200-line cold tail.
    // Probe only its send boundary instead of widening every session load or
    // scanning the whole rollout. The unique client_id still decides whether
    // the entry is removed.
    const firstLoadedIndex = cache.bySession[props.sessionId]?.firstLoadedIndex ?? 0;
    for (const entry of promptPending.pending(props.sessionId)) {
      const range = pendingPromptProbeRange(entry, firstLoadedIndex);
      if (!range || pendingProbeAttempted.has(entry.id)) continue;
      pendingProbeAttempted.add(entry.id);
      void readSessionRange(props.sessionId, range.from, range.to)
        .then((response) => {
          const probe: string[] = [];
          for (const line of response.lines) probe[line.index] = line.raw;
          if (matchedCodexPendingPromptIds(probe, [entry]).includes(entry.id)) {
            promptPending.remove(props.sessionId, entry.id);
            forceScrollSoon();
          }
        })
        .catch((error) => {
          // A transient range failure should not make the duplicate permanent:
          // allow the next cache/tail mutation to retry this tiny probe.
          pendingProbeAttempted.delete(entry.id);
          console.warn("pending prompt reconciliation probe failed", error);
        });
    }
  } else {
    // Clear an optimistic chip only when a genuine user landing (its own
    // `queue-operation enqueue` / `type:"user"` record) appears at/after its
    // send-time line count — NOT on mere line growth. Plain growth would drop
    // the chip the instant the in-flight turn streams another line, leaving a
    // gap before the durable queue chip lands (~140 ms).
    for (const e of [...entries]) {
      for (let i = Math.max(0, e.startedAtLineCount); i < lines.value.length; i++) {
        if (isUserLandingLine(lines.value[i])) { promptPending.remove(props.sessionId, e.id); break; }
      }
    }
  }
}

// Does this line represent the user's own message actually landing? Used to
// clear the pending prompt bubble. Plain line-count growth is NOT enough: if
// the user sends while a turn is still streaming, the running turn's
// assistant/tool/system lines would grow lines.length and prematurely clear
// the bubble before the real record lands. So clear only on a genuine user
// landing:
//   - codex: rollout `event_msg/user_message`
//   - claude: a real `type:"user"` text record (not tool_result/meta/sidechain),
//     or a mid-turn `queue-operation` enqueue (queued behind a live turn).
function isUserLandingLine(ln: string | undefined): boolean {
  if (!ln) return false;
  if (ln.indexOf('"user_message"') >= 0) {
    try { const r = JSON.parse(ln) as { payload?: { type?: unknown } }; if (r?.payload?.type === "user_message") return true; } catch { /* fall through */ }
  }
  if (ln.indexOf('"queue-operation"') >= 0) {
    try { const r = JSON.parse(ln); if (isQueueOperation(r as Record<string, unknown>) && (r as { operation?: string }).operation === "enqueue") return true; } catch { /* fall through */ }
  }
  if (ln.indexOf('"type":"user"') >= 0) {
    try {
      const r = JSON.parse(ln) as { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { role?: string; content?: unknown } };
      if (r?.type === "user" && r.message?.role === "user" && !r.isMeta && !r.isSidechain) {
        const c = r.message.content;
        const isToolResult = Array.isArray(c) && c.some((b) => (b as { type?: string })?.type === "tool_result");
        if (!isToolResult) return true;
      }
    } catch { /* fall through */ }
  }
  return false;
}

function pendingPromptNode(prompt: PendingPrompt): { record: Record<string, unknown> } {
  return {
    record: {
      type: "user",
      message: {
        role: "user",
        content: prompt.text,
      },
    },
  };
}

const messageDisplayStyle = computed(() => prefs.messageDisplayStyle);
const messageDisplayClass = computed(() => `cw-display-${messageDisplayStyle.value}`);
const stickyPromptUuid = ref<string | null>(null);
const CLAUDE_CODE_STICKY_GAP_PX = 12;
// Pixels to shove the currently-pinned prompt upward as the next prompt rises
// into it — produces the genuine Claude Code "the next bubble pushes the
// previous one out" feel instead of the new prompt sliding underneath it.
const stickyPushPx = ref(0);
const stickyPromptStyles = new Set(["claude-code", "codex", "antigravity"]);
// claude-code pins via an absolute overlay, so the push math must measure the
// overlay's own rendered height (it has its own padding / mobile max-height
// clip / independently-toggled preview collapse) — NOT the in-flow entry.
const stickyOverlayEl = ref<HTMLElement | null>(null);
let stickyOverlayRO: ResizeObserver | null = null;
watch(stickyOverlayEl, (n) => {
  if (!stickyOverlayRO) stickyOverlayRO = new ResizeObserver(() => recomputeStickyPrompt());
  stickyOverlayRO.disconnect();
  if (n) stickyOverlayRO.observe(n);
});

function onContentClick(e: MouseEvent) {
  const target = e.target as Element | null;
  const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor || !scroller.value?.contains(anchor)) return;
  const href = anchor.getAttribute("href") ?? anchor.href;
  const local = localFileFromHref(href, window.location.href);
  if (local) {
    e.preventDefault();
    e.stopPropagation();
    if (local.openInSystem) {
      void revealLocalPath(local.path)
        .then(() => notificationsStore.pushInfo("Opened in the system file manager"))
        .catch(err => notificationsStore.pushError(
          err instanceof Error ? err.message : String(err),
          { title: "Could not open local path" },
        ));
      return;
    }
    if (local.isImage) {
      lightbox.open(codexImageUrl(local.path), basenameFromPath(local.path));
      return;
    }
    localFileViewer.show(props.sessionId, local.path, local.line);
    return;
  }

  // Android/Chrome standalone PWAs do not reliably surface target=_blank
  // navigations. Use an in-context navigation for out-of-scope web URLs; the
  // browser then hands the external page off while preserving the installed
  // app. Ordinary browser tabs keep the Markdown renderer's new-tab behavior.
  const external = standaloneExternalNavigationHref(href, window.location.href);
  if (!external) return;
  e.preventDefault();
  e.stopPropagation();
  window.location.assign(external);
}

// ─── Stall detection ───
// "Stalled" = claude has been running for STALL_MS without writing anything
// new to the jsonl. Usually means the upstream LLM router (or the API
// endpoint behind it) is wedged on a slow/hung request. Show a red banner
// with a Retry button instead of the indefinite "thinking…" dots.
const STALL_MS = 10 * 60 * 1000; // 10 minutes — long thinking / background waits make 3-min silence routine
// A tool call that's still executing (e.g. a long `codex exec` / Bash / test
// run) writes NOTHING to the jsonl for its whole duration, so the plain 3-min
// silence check would cry "upstream wedged" on perfectly healthy long work —
// the "等 codex 很久就显示对话好像没了" complaint. While a tool is in flight we
// (a) show a calm "running…" indicator instead of the red alarm, and (b) only
// escalate to the alarm after a much longer TOOL_STALL_MS, so a genuinely hung
// command still surfaces eventually.
const TOOL_STALL_MS = 12 * 60 * 1000; // 12 minutes — tool running absurdly long
const lastActivityAt = ref<number>(0);
const now = ref<number>(Date.now());
let stallTimer: ReturnType<typeof setInterval> | null = null;

// Reset the stall clock whenever the timeline grows (claude wrote
// something — assistant chunk, tool_use, anything) or whenever running
// flips. The clock starts the moment running first becomes true.
watch(running, (isRunning) => {
  if (isRunning) lastActivityAt.value = Date.now();
  else lastActivityAt.value = 0;
}, { immediate: true });
watch(() => timeline.value.length, () => {
  if (running.value) lastActivityAt.value = Date.now();
});

onMounted(() => {
  // Re-tick every second so the "thinking… 23s" elapsed counter updates
  // smoothly and isStalled flips on the 3-min boundary without lag.
  stallTimer = setInterval(() => { now.value = Date.now(); }, 1000);
});
onBeforeUnmount(() => {
  if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
});

// ─── Pull-to-refresh ───────────────────────────────────────────────────────
// WeChat-style: when the scroller is at the very top, pulling down past
// PULL_THRESHOLD then releasing kicks a refresh that wakes the WS,
// re-pulls the sessions list, and resets+re-engages this conversation.
// Avoids the "reload the whole page through the proxy" pain when sidebar
// previews / message stream feel stale after a long suspend.
//
// touchmove must be NON-passive so we can preventDefault and suppress the
// native overscroll bounce while we own the gesture. Vue's @touchmove is
// passive by default in v3, so we attach via addEventListener manually.
type PullState = "idle" | "pulling" | "refreshing";
const pullState = ref<PullState>("idle");
const pullDistance = ref(0);
const PULL_THRESHOLD = 60;
const PULL_MAX = 90;
const PULL_REFRESH_HOLD = 50;
const PULL_START_SLOP = 8;
let pullStartY = 0;
let pullActive = false;

function onPullTouchStart(e: TouchEvent) {
  if (pullState.value === "refreshing") return;
  const el = scroller.value;
  if (!el) return;
  if (el.scrollTop > 0) return;
  if (e.touches.length !== 1) return;
  pullStartY = e.touches[0]?.clientY ?? 0;
  pullActive = true;
}

function onPullTouchMove(e: TouchEvent) {
  if (!pullActive || pullState.value === "refreshing") return;
  const el = scroller.value;
  if (!el) return;
  // Bail if user scrolled off the top mid-gesture (e.g. native scroll
  // happened before our handler took over) — leave the rest to native.
  if (el.scrollTop > 0) {
    pullActive = false;
    pullDistance.value = 0;
    pullState.value = "idle";
    return;
  }
  const y = e.touches[0]?.clientY ?? pullStartY;
  const dy = y - pullStartY;
  if (dy <= PULL_START_SLOP) {
    pullDistance.value = 0;
    pullState.value = "idle";
    return;
  }
  // Resistance curve: half the actual delta, capped at PULL_MAX. Feels
  // like rubber-band tension instead of 1:1 finger-following.
  pullDistance.value = Math.min((dy - PULL_START_SLOP) * 0.5, PULL_MAX);
  pullState.value = "pulling";
  e.preventDefault();
}

async function onPullTouchEnd() {
  if (!pullActive) return;
  pullActive = false;
  if (pullState.value !== "pulling") return;
  if (pullDistance.value >= PULL_THRESHOLD) {
    await runPullRefresh();
  } else {
    pullDistance.value = 0;
    pullState.value = "idle";
  }
}

async function runPullRefresh() {
  pullState.value = "refreshing";
  pullDistance.value = PULL_REFRESH_HOLD;
  try {
    wsWake({ forceReconnect: true });
    await Promise.all([
      sessions.fetchAll().catch(() => undefined),
      // Force-reconnect replays the existing session subscription on open.
      // Avoid resetAndReengage here: doing unsubscribe/subscribe while the new
      // socket is CONNECTING can race the WS layer's own onopen re-subscribe.
      // Floor: keep the spinner visible long enough to feel intentional
      // even when the refresh itself completes in under 100 ms.
      new Promise((r) => setTimeout(r, 350)),
    ]);
  } finally {
    pullDistance.value = 0;
    pullState.value = "idle";
  }
}

onMounted(() => {
  const el = scroller.value;
  if (!el) return;
  el.addEventListener("touchstart", onPullTouchStart, { passive: true });
  el.addEventListener("touchmove", onPullTouchMove, { passive: false });
  el.addEventListener("touchend", onPullTouchEnd, { passive: true });
  el.addEventListener("touchcancel", onPullTouchEnd, { passive: true });
});
onBeforeUnmount(() => {
  const el = scroller.value;
  if (!el) return;
  el.removeEventListener("touchstart", onPullTouchStart);
  el.removeEventListener("touchmove", onPullTouchMove);
  el.removeEventListener("touchend", onPullTouchEnd);
  el.removeEventListener("touchcancel", onPullTouchEnd);
});

const pullIndicatorLabel = computed(() => {
  if (pullState.value === "refreshing") return "刷新中…";
  if (pullDistance.value >= PULL_THRESHOLD) return "松开刷新";
  if (pullDistance.value > 0) return "下拉刷新";
  return "";
});

// A tool is still executing when the most-recent tool-bearing timeline node
// has a pair with no result yet. Scanning from the end (not the whole history)
// keeps an old interrupted/never-resolved tool_use from suppressing the alarm
// forever — only the latest tool activity counts. Covers both claude (Bash /
// codex exec) and codex (adapted exec) since both flow through `timeline`.
const openToolPair = computed<{ pair: ToolPair; startedAt: number } | null>(() => {
  const tl = timeline.value;
  for (let i = tl.length - 1; i >= 0; i--) {
    const n = tl[i];
    if (n && n.kind === "event" && n.toolPairs && n.toolPairs.length > 0) {
      const pair = n.toolPairs.find((p) => p.result === undefined);
      if (!pair) return null;
      // Timestamp of the assistant record that carried the tool_use — close
      // enough to when the tool started. NaN → fall back to turn elapsed.
      const ts = Date.parse(String((n.record as { timestamp?: unknown }).timestamp ?? ""));
      return { pair, startedAt: Number.isFinite(ts) ? ts : 0 };
    }
  }
  return null;
});
const toolInProgress = computed(() => openToolPair.value !== null);

// Spinner label while a tool is in flight: "⚙ <summary>". The elapsed span
// next to it shows per-tool elapsed (see spinnerElapsed).
const runningToolLabel = computed<string>(() => {
  const open = openToolPair.value;
  if (!open) return "";
  let label = toolSummary(open.pair.use.name, open.pair.use.input);
  if (label.length > 60) label = label.slice(0, 60) + "…";
  // An unfinished pair may actually be blocked on the user's own Approve/Deny —
  // saying "⚙ running" with a growing timer there is wrong.
  const waiting = pendingInteractions
    .list(props.sessionId)
    .some((it) => it.toolUseId === open.pair.use.id);
  return waiting ? `⏸ Waiting for approval · ${label}` : `⚙ ${label}`;
});
const stallThresholdMs = computed(() => (toolInProgress.value ? TOOL_STALL_MS : STALL_MS));
const isStalled = computed(() =>
  running.value
  && lastActivityAt.value > 0
  && (now.value - lastActivityAt.value) > stallThresholdMs.value,
);

// TOTAL time the current turn has been running — anchored on the backend's
// lastBoundaryAt (which is the moment the user's prompt arrived). Mid-turn
// assistant chunks and tool_use writes don't bump the anchor, so the
// counter strictly measures total turn duration, not step time. Matches
// the sidebar's "Claude is thinking… Ns" indicator.
//
// Falls back to lastActivityAt (running-became-true / last write) only if
// the backend hasn't pushed a boundary timestamp yet (very brief window
// just after page load on a session that's already running).
const thinkingElapsed = computed<string>(() => {
  if (!running.value) return "";
  const item = sessions.byId[props.sessionId];
  const boundaryStr = item?.lastBoundaryAt;
  const boundaryMs = boundaryStr ? Date.parse(boundaryStr) : NaN;
  const anchor = Number.isFinite(boundaryMs) ? boundaryMs : lastActivityAt.value;
  if (!anchor || anchor <= 0) return "";
  const sec = Math.max(0, Math.floor((now.value - anchor) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
});

// Elapsed shown next to the spinner label: per-tool elapsed (since the
// tool_use record's timestamp) when a tool is in flight, else total turn
// elapsed. Falls back to turn elapsed when the record carries no timestamp.
const spinnerElapsed = computed<string>(() => {
  const open = openToolPair.value;
  if (open && open.startedAt > 0) {
    const sec = Math.max(0, Math.floor((now.value - open.startedAt) / 1000));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return thinkingElapsed.value;
});

// Recover the most recent user-prompt text so Retry can re-issue it.
function lastUserPromptText(): string {
  for (let i = timeline.value.length - 1; i >= 0; i--) {
    const node = timeline.value[i];
    if (!node || node.kind !== "event") continue;
    const r = node.record as { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } };
    if (r.type !== "user" || r.isMeta || r.isSidechain) continue;
    const c = r.message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const t = c.find((b) => (b as { type?: string }).type === "text") as { text?: string } | undefined;
      if (t?.text) return t.text;
    }
    return "";
  }
  return "";
}

const retrying = ref(false);
async function stopAndRetry() {
  if (retrying.value) return;
  const text = lastUserPromptText();
  if (!text) return;
  retrying.value = true;
  try {
    await stopSession(props.sessionId);
    // Brief gap so the backend's stop-then-spawn path has finished tearing
    // down the killed child (processRegistry unregister, jsonl flush)
    // before doPrompt re-enters with a fresh --resume.
    await new Promise((r) => setTimeout(r, 300));
    await sendPrompt(props.sessionId, text);
    lastActivityAt.value = Date.now(); // reset stall clock for the new turn
  } catch (e) {
    console.error("stop+retry failed", e);
  } finally {
    retrying.value = false;
  }
}

// Track genuine user-landing records, not only array length. A cursor-only
// liveness update can grow the sparse cache before the actual user record is
// delivered; filling that existing array hole does not change `lines.length`.
// This signal changes when the hole is filled, closing the same race that
// produced the duplicate optimistic bubble.
const pendingLandingSignal = computed(() => {
  const entries = pendingPrompts.value;
  if (!entries.length) return "";
  const earliest = Math.max(0, Math.min(...entries.map((entry) => entry.startedAtLineCount)) - 4);
  const landed: string[] = [];
  for (let index = earliest; index < lines.value.length; index++) {
    const line = lines.value[index];
    if (!line) continue;
    if (
      line.includes('"user_message"') ||
      line.includes('"queue-operation"') ||
      line.includes('"type":"user"')
    ) {
      landed.push(`${index}:${line}`);
    }
  }
  return landed.join("\n");
});

// Clear the pending text bubble as soon as the real user record arrives in
// the session cache after we started waiting — the optimistic bubble is no
// longer needed. Also force-scroll the new line into view: the timeline
// watch is gated on lockedToBottom — which iOS Safari can silently flip to
// false during the layout pass when the bubble was added.
watch([
  pendingLandingSignal,
  () => pendingPrompts.value.length,
  () => cache.bySession[props.sessionId]?.firstLoadedIndex ?? 0,
], () => {
  const before = pendingPrompts.value.length;
  reconcilePendingPrompts();
  if (pendingPrompts.value.length < before) forceScrollSoon();
}, { immediate: true });

// Walk forward, remembering the most recent assistant message's usage.
// TurnDurationBlock nodes get that usage attached so they can show context-window utilization.
const decorated = computed<DecoratedEntry[]>(() => {
  let lastUsage: Usage | null = null;
  return timeline.value.map((node) => {
    if (node.kind !== "event") return { node, usage: null };
    const rec = node.record as { type?: string; message?: { usage?: Usage }; subtype?: string };
    if (rec.type === "assistant" && rec.message?.usage) {
      lastUsage = rec.message.usage;
    }
    const usage = (rec.type === "system" && rec.subtype === "turn_duration") ? lastUsage : null;
    return { node, usage };
  });
});

// Stable per-record key for v-for. The previous key (`renderedSlice.start + i`)
// shifted every time decorated.length grew — which is EVERY WS stream-line
// during a live reply, AND when cache.restore lands in the background. The
// shifting key made Vue treat every visible block as a new component on every
// growth → unmount + remount the entire window. Big perf hit.
//
// Using uuid (or a timestamp+type composite for synthetic system records that
// lack a uuid) keeps each block's identity stable across decorated re-runs,
// so Vue's diff sees no change and does nothing. Both the "cache restore
// lands and renderedSlice slides" and "assistant streaming new lines" paths
// benefit.
function keyFor(entry: { node: TimelineNode; usage: Usage | null }): string {
  if (entry.node.kind !== "event") return "n/a";
  const r = entry.node.record as Record<string, unknown>;
  const uuid = r.uuid;
  if (typeof uuid === "string" && uuid) return uuid;
  // Fallback for system records that lack uuid. Composite of fields that
  // shouldn't change once the record is in the file.
  return `${String(r.type ?? "?")}|${String(r.subtype ?? "")}|${String(r.timestamp ?? "")}`;
}

// Claude Code writes text / thinking / tool_use as SEPARATE assistant records.
// A record with none of those renders an empty block. A refusal record has
// empty content too but DOES render its banner, so it's explicitly excluded.
//
// Thinking-only records (no text / tool_use) are treated as empty too — they
// break tool-run collapsing and scatter tiny "✻ N" toggles everywhere when
// DeepSeek streams interleaved thinking chunks. When a record has both thinking
// AND real content (text / tool_use), it still renders normally with the fold
// toggle in AssistantBlock.
function isEmptyAssistantEntry(entry: DecoratedEntry): boolean {
  const node = entry.node;
  if (node.kind !== "event" || node.block !== "AssistantBlock") return false;
  const msg = node.record.message as { content?: unknown; stop_reason?: unknown } | undefined;
  if (msg?.stop_reason === "refusal") return false;
  const content = msg?.content;
  if (!Array.isArray(content)) return false;
  return !content.some((b) => {
    const o = b as { type?: unknown; thinking?: unknown };
    // ponytail: thinking-only records are dropped — avoids DeepSeek "✻"
    // noise while keeping mixed content+thinking blocks intact.
    return o?.type === "text" || o?.type === "tool_use";
  });
}

function collapsibleToolItems(entry: DecoratedEntry): ToolRunItem[] | null {
  const node = entry.node;
  if (node.kind !== "event" || node.block !== "AssistantBlock") return null;
  const content = (node.record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  if (!content.every((b) => (b as { type?: unknown })?.type === "tool_use")) return null;
  const pairs = node.toolPairs ?? [];
  if (pairs.length !== content.length || pairs.length === 0) return null;
  for (const pair of pairs) {
    if (pair.result === undefined) return null;
    // preview / subagentTimeline / workflow results stay out of tool runs so
    // their rich payloads surface at one fold, not three.
    if (pair.preview || pair.subagentTimeline || pair.workflow) return null;
    if (pair.use.name === "AskUserQuestion" || pair.use.name === "Agent") return null;
  }
  return pairs.map((pair) => ({ pair, uuid: recordUuid(entry) || pair.use.id }));
}

// Windowed render: render only the most recent INITIAL_RENDER_FAST items on
// first paint. Long sessions used to take seconds to first paint because Vue
// had to instantiate every UserPromptBlock / AssistantBlock + Shiki highlight
// every code fence on every line, blocking the scroll-to-bottom snap.
//
// Two-stage strategy:
//   * INITIAL_RENDER_FAST (30) is what we render synchronously on mount —
//     enough to fill ~one mobile viewport at the bottom. User sees content
//     in well under half a second even on a 5000-line conversation.
//   * INITIAL_RENDER_FULL (200) is the steady-state window. We expand to it
//     in an idle callback after first paint so "Load earlier" only needs
//     one tap to reveal real history (RENDER_BATCH-worth above the current
//     window) instead of having the user click 7 times to expand from 30.
const INITIAL_RENDER_FAST = 30;
const INITIAL_RENDER_FULL = 200;
const RENDER_BATCH = 200;
const renderLimit = ref(INITIAL_RENDER_FAST);
const renderedSlice = computed(() => {
  const all = decorated.value;
  const start = Math.max(0, all.length - renderLimit.value);
  return { start, items: all.slice(start) };
});

// Collapse any run of 2+ consecutive tool calls into a compact ToolRunBlock —
// nobody scrolls through a long stack of individual Read/Bash rows, and the
// per-row spacing wastes vertical space. (Was 4.)
const TOOL_RUN_MIN = 2;
const renderedRows = computed<RenderRow[]>(() => {
  const rows: RenderRow[] = [];
  // Drop truly-empty assistant records first (no text / tool_use / non-empty
  // thinking): they render nothing but a blank avatar-height gap, and removing
  // them lets the tool records they sat between collapse into one run.
  // Thinking-only records DO render now (a tiny "✻ N" fold toggle), so
  // interleaved thinking→tool→thinking sequences no longer merge into a single
  // tool run — each thinking record is one small glyph between tool rows.
  const entries = renderedSlice.value.items.filter((e) => !isEmptyAssistantEntry(e));
  for (let i = 0; i < entries.length;) {
    const firstItems = collapsibleToolItems(entries[i]!);
    if (!firstItems) {
      rows.push({ kind: "entry", entry: entries[i]! });
      i++;
      continue;
    }

    const runEntries: DecoratedEntry[] = [entries[i]!];
    const runItems: ToolRunItem[] = [...firstItems];
    i++;
    while (i < entries.length) {
      const nextItems = collapsibleToolItems(entries[i]!);
      if (!nextItems) break;
      runEntries.push(entries[i]!);
      runItems.push(...nextItems);
      i++;
    }

    if (runEntries.length >= TOOL_RUN_MIN) {
      rows.push({ kind: "toolRun", key: `tool-run:${keyFor(runEntries[0]!)}`, items: runItems });
    } else {
      for (const entry of runEntries) rows.push({ kind: "entry", entry });
    }
  }
  return rows;
});
// Two distinct sources of "older content":
//   1. unloadedAbove — lines that exist on disk but the cache hasn't fetched
//      (sparse padding from the tail-N initial load). These need a backend
//      round-trip via read-range to populate cache.
//   2. hiddenAbove — lines already in the cache + decorated, but truncated
//      out of the rendered window by renderLimit. Just expand renderLimit.
// Either condition keeps the "↑ Load earlier" affordance live.
const cacheEntry = computed(() => cache.bySession[props.sessionId]);
const unloadedAbove = computed(() => cacheEntry.value?.firstLoadedIndex ?? 0);
const hiddenAbove = computed(() => renderedSlice.value.start);
// Internal trigger for loadEarlier() — fires on EITHER unloaded-on-disk lines
// OR window-trimmed cached lines. The auto-load-on-scroll path uses this so
// scrolling to the top still pulls in older content.
const canLoadEarlier = computed(() => unloadedAbove.value > 0 || hiddenAbove.value > 0);
// Visible "↑ Load earlier" button: show for both already-cached hidden rows
// and not-yet-fetched older file ranges. Codex fork rollouts can have a long
// inherited prefix, and relying only on scroll-near-top autoload makes it look
// like the top of the conversation is missing.
const showLoadEarlierButton = computed(() => canLoadEarlier.value);

// Throttle so a single user gesture (or the nav-up tap) doesn't trigger
// loadEarlier ten times before Vue has a chance to render the new batch.
// Reactive so the "↑ Load earlier" button can show a busy state: 'all' mode
// fetches the whole prefix + re-decorates before the first paint, and a
// scroll-near-top auto-load can already hold the gate — without feedback a tap
// looks like it did nothing ("点了要很久ui没显示" / "经常不work").
const loadEarlierInflight = ref(false);

// Grow the render window by `by` rows, then restore the viewport: prepending
// items above must not shift the content under the user's finger. Returns once
// Vue has painted the new rows. Standard chat-app scroll-anchoring trick.
async function growRenderWindow(by: number): Promise<void> {
  const el = scroller.value;
  const beforeHeight = el?.scrollHeight ?? 0;
  const beforeTop = el?.scrollTop ?? 0;
  renderLimit.value = Math.min(decorated.value.length, renderLimit.value + by);
  await nextTick();
  if (el) {
    const delta = el.scrollHeight - beforeHeight;
    if (delta > 0) el.scrollTop = beforeTop + delta;
  }
}

async function loadEarlier(mode: "chunk" | "all" = "chunk"): Promise<boolean> {
  if (loadEarlierInflight.value) return false;
  if (!canLoadEarlier.value) return false;
  loadEarlierInflight.value = true;
  try {
    // Step 1: backfill unloaded older lines from disk. "chunk" pulls one
    // RENDER_BATCH (one screen) per tap; "all" pulls the whole prefix in ONE
    // round-trip — readRange reads the file whole per call, so looping it would
    // re-read a 65MB codex fork rollout N times. The fetch was never the
    // bottleneck (0.7s for 75MB); rendering it all at once was.
    const entry = cacheEntry.value;
    if (entry && entry.firstLoadedIndex > 0) {
      const to = entry.firstLoadedIndex;
      const from = mode === "all" ? 0 : Math.max(0, to - RENDER_BATCH);
      try {
        const r = await readSessionRange(props.sessionId, from, to);
        cache.appendBatch(props.sessionId, r.lines.map((ln) => ({ index: ln.index, raw: ln.raw })));
      } catch (err) {
        // Backend hiccup — fall through to expanding the render window with
        // whatever we already have, so the user still sees SOMETHING happen.
        console.error("loadEarlier read-range failed", err);
      }
    }
    // Step 2: reveal the freshly-loaded (or cached-but-windowed-out) entries.
    if (mode !== "all") {
      await growRenderWindow(RENDER_BATCH);
      return true;
    }
    // "Load all earlier": reveal the full history (a forked codex rollout can be
    // ~20k rows / 65MB) in RENDER_BATCH steps, yielding a frame between each so
    // decorating + Shiki highlighting stays off the critical path and the tab
    // keeps painting. The old one-shot renderLimit = MAX_SAFE_INTEGER froze the
    // tab on large sessions ("加载不出来"). Hard guard caps the loop.
    let guard = 0;
    while (renderLimit.value < decorated.value.length && guard++ < 5000) {
      await growRenderWindow(RENDER_BATCH);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    return true;
  } finally {
    // Release the gate after the next paint so the user can immediately
    // scroll/tap again to load another batch.
    requestAnimationFrame(() => { loadEarlierInflight.value = false; });
  }
}

// Auto-load older messages when the user scrolls within this many px of the
// top — matches WeChat / iMessage feel. Threshold is generous enough that
// fast momentum scrolling triggers before the user actually hits the wall.
const AUTO_LOAD_THRESHOLD_PX = 200;

const blockMap = {
  UserPromptBlock, UserToolResultBlock, UserCompactSummaryBlock,
  TaskNotificationBlock,
  AssistantBlock, AssistantApiErrorBlock,
  TurnDurationBlock, AwaySummaryBlock, LocalCommandBlock,
  ApiErrorBlock, CompactBoundaryBlock,
} as const;

function comp(kind: string | null) {
  return kind ? (blockMap as Record<string, unknown>)[kind] : null;
}

function keyForRow(row: RenderRow): string {
  return row.kind === "toolRun" ? row.key : keyFor(row.entry);
}

// Threshold for "I'm at the bottom" — affects both whether the auto-
// follow watcher chases new content AND whether the floating ↓ button
// shows. 80px was so generous that ~half a screen of unread content
// still counted as "at the bottom" and the button never appeared. 24px
// (~one line) is the smallest threshold that still tolerates iOS
// momentum-scroll occasionally undershooting scrollHeight.
const NEAR_BOTTOM_PX = 24;

function onScroll() {
  const el = scroller.value;
  if (!el) return;
  lockedToBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX;
  recomputePromptNav();
  recomputeStickyPrompt();
  // Auto-load older history when the user scrolls near the top — same
  // pattern as WeChat / iMessage. Throttled inside loadEarlier so even a
  // momentum-scroll burst only fires one batch per render.
  if (el.scrollTop < AUTO_LOAD_THRESHOLD_PX) loadEarlier();
}

// ---------------------------------------------------------------------------
// User-prompt navigator: jump up/down between the user's own prompts in the
// transcript. Anchor is the current scrollTop + a small offset (so even when
// you've scrolled an inch into a turn, ↑ still jumps to that turn's user
// prompt rather than the prior one). Re-scans the DOM on scroll because the
// number of prompts and their offsets change as more content streams in.
const NAV_ANCHOR_OFFSET_PX = 12;
const promptOffsets = ref<number[]>([]);
const navUpEnabled = ref(false);
const navDownEnabled = ref(false);

// jumpToPrompt lands the chosen prompt at scrollTop = target - LAND_OFFSET_PX
// (so the prompt's row isn't cropped by the scroller's top edge). Both
// anchors below are derived from that landing position to be self-consistent
// across repeated presses:
//
//   ↓ anchor = scrollTop + NAV_ANCHOR_OFFSET_PX
//     = target - LAND_OFFSET + NAV_ANCHOR_OFFSET
//     = target + (NAV - LAND)  // currently +4
//   filter `t > anchor + 1` excludes target itself ✓
//
//   ↑ anchor used to be the same scrollTop + NAV_ANCHOR_OFFSET, which made
//   the filter `t < anchor - 1` match the current prompt as well — so
//   pressing ↑ a second time stayed on the same prompt forever. Use plain
//   scrollTop (no forward offset) so target itself never qualifies and a
//   chain of ↑ presses walks all the way to the top.
const LAND_OFFSET_PX = 8;

function recomputePromptNav() {
  const el = scroller.value;
  if (!el) { navUpEnabled.value = false; navDownEnabled.value = false; return; }
  const nodes = el.querySelectorAll<HTMLElement>("[data-user-prompt='true']");
  const tops: number[] = [];
  // offsetTop chain doesn't always anchor at the scroller. Use
  // getBoundingClientRect deltas instead, which is robust to nesting.
  const elRect = el.getBoundingClientRect();
  for (const n of nodes) {
    const r = n.getBoundingClientRect();
    tops.push(r.top - elRect.top + el.scrollTop);
  }
  promptOffsets.value = tops;
  const upAnchor = el.scrollTop;
  const downAnchor = el.scrollTop + NAV_ANCHOR_OFFSET_PX;
  // ↑ is also enabled if there's older content not yet rendered (window
  // truncated) OR not yet fetched (sparse cache from tail-N initial load) —
  // clicking it will trigger loadEarlier and then jump.
  navUpEnabled.value = tops.some((t) => t < upAnchor - 1) || canLoadEarlier.value;
  // ↓ is also enabled when there's no further prompt below but we're not
  // yet at the absolute bottom — clicking it falls through to "scroll to
  // the latest reply" (see jumpToPrompt('down')'s tail).
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX;
  navDownEnabled.value = tops.some((t) => t > downAnchor + 1) || !atBottom;
}

function recomputeStickyPrompt() {
  const el = scroller.value;
  if (!el || !stickyPromptStyles.has(messageDisplayStyle.value)) {
    stickyPromptUuid.value = null;
    stickyPushPx.value = 0;
    return;
  }
  const nodes = el.querySelectorAll<HTMLElement>(".cw-user-prompt-anchor[data-user-prompt='true']");
  const elRect = el.getBoundingClientRect();
  const isClaudeCode = messageDisplayStyle.value === "claude-code";
  const stickyTop = isClaudeCode ? CLAUDE_CODE_STICKY_GAP_PX : 0;
  const anchor = el.scrollTop + stickyTop + 1;
  let active: string | null = null;
  let activeTop = -Infinity;
  // Content-space top of the next prompt below the pinned one (Infinity = none).
  const tops: number[] = [];
  const anchorByUuid = new Map<string, HTMLElement>();
  for (const n of nodes) {
    const uuid = n.dataset.uuid || null;
    if (!uuid) continue;
    anchorByUuid.set(uuid, n);
    const r = n.getBoundingClientRect();
    const top = r.top - elRect.top + el.scrollTop;
    tops.push(top);
    if (top <= anchor && top > activeTop) {
      activeTop = top;
      active = uuid;
    }
  }
  if (stickyPromptUuid.value !== active) stickyPromptUuid.value = active;

  // Push: as the next prompt rises into the pinned one's footprint, slide the
  // pinned one up by exactly the overlap so it's evicted rather than overlaid.
  let push = 0;
  if (active) {
    let nextTop = Infinity;
    for (const t of tops) if (t > activeTop + 1 && t < nextTop) nextTop = t;
    if (nextTop !== Infinity) {
      let pinBottom: number;
      if (isClaudeCode && stickyOverlayEl.value) {
        // claude-code pins via the absolute overlay, not the in-flow entry —
        // measure the overlay itself. Use the frame's rect for position (the
        // frame never gets the translateY, so no need to undo the transform —
        // reading the overlay's own rect would race Vue's style patch by a
        // frame) and offsetHeight for size (layout value, transform-immune).
        // The overlay sits at the frame's top (top: 0), so its at-rest bottom
        // in the scroller's content space is:
        const frame = stickyOverlayEl.value.parentElement!;
        const frameTop = frame.getBoundingClientRect().top - elRect.top + el.scrollTop;
        pinBottom = frameTop + stickyOverlayEl.value.offsetHeight + 4;
      } else {
        const entry = anchorByUuid.get(active)?.nextElementSibling as HTMLElement | null;
        // Match the CSS sticky row offset.
        // Use the clipped sticky row height, not the inner content's natural
        // height. Pinned prompts are max-height clipped on mobile; measuring the
        // child would over-push by the hidden height.
        const h = entry ? entry.getBoundingClientRect().height : 0;
        pinBottom = el.scrollTop + stickyTop + h + 4;
      }
      if (nextTop < pinBottom) push = pinBottom - nextTop;
    }
  }
  const roundedPush = Math.max(0, Math.round(push));
  if (stickyPushPx.value !== roundedPush) stickyPushPx.value = roundedPush;
}

function jumpToPrompt(direction: "up" | "down") {
  const el = scroller.value;
  if (!el) return;
  recomputePromptNav();
  const tops = promptOffsets.value;
  let target: number | null = null;
  if (direction === "up") {
    // Strictly above current scrollTop — see comment above LAND_OFFSET_PX.
    const anchor = el.scrollTop;
    for (const t of tops) if (t < anchor - 1 && (target === null || t > target)) target = t;
    // Nothing above in the rendered window — but there's older history not
    // yet rendered. Expand the window and re-try after Vue paints, so a
    // user mashing ↑ walks through the entire conversation, not just the
    // currently-rendered slice.
    if (target === null && canLoadEarlier.value) {
      // loadEarlier is async (may need a backend round-trip for read-range);
      // await it before retrying so the new prompts are actually in the DOM.
      void loadEarlier().then((advanced) => {
        if (advanced) setTimeout(() => jumpToPrompt("up"), 80);
      });
      return;
    }
  } else {
    // Forgive a small offset so a partial scroll into a turn still steps to
    // the NEXT prompt rather than re-selecting the current one.
    const anchor = el.scrollTop + NAV_ANCHOR_OFFSET_PX;
    for (const t of tops) if (t > anchor + 1 && (target === null || t < target)) target = t;
    // Past the last user prompt — fall through to the absolute bottom of the
    // chat so ↓ ↓ ↓ from anywhere always lands you on the latest assistant
    // reply, instead of stalling on the last user message. Matches the
    // user's mental model: ↑ walks back through their prompts, ↓ walks
    // forward and finally to "the latest reply".
    if (target === null) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      return;
    }
  }
  if (target === null) return;
  // Land slightly above the prompt's top edge so the row's border doesn't
  // get cropped by the scroller's own padding/shadow.
  el.scrollTo({ top: Math.max(0, target - LAND_OFFSET_PX), behavior: "smooth" });
}

function scrollToBottom() {
  const el = scroller.value;
  if (!el) return;
  // Eagerly hide the button so it doesn't linger during the animation.
  lockedToBottom.value = true;
  // Use the same rAF re-pinning loop as session-switch so this stays glued
  // to the bottom even if Shiki / late assistant chunks keep growing
  // scrollHeight after the smooth-scroll completes. Without this, mid-
  // animation late content lands above the fold and the button comes
  // back even though the user just clicked it.
  el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  pinToBottomUntilStable(800);
}

// Auto-scroll to bottom when ANY of the things that can grow scrollHeight
// changes — not just the timeline. The pending-prompt bubble and the
// "Claude is thinking…" indicator live outside the timeline; without
// watching them too, they push scrollHeight up while scrollTop stays
// the same and the user has to manually scroll to find the new content.
// renderLimit is critical: on mount we render only INITIAL_RENDER_FAST
// (30) items for first-paint speed, then requestIdleCallback expands to
// INITIAL_RENDER_FULL (200). Those 170 extra items are inserted ABOVE
// current content, which keeps scrollTop numerically the same but pushes
// the user visually mid-page. Without renderLimit in this dep list, an
// idle session would never re-pin and the user lands stuck mid-conversation.
watch([timeline, running, renderLimit, () => queueChips.value.length], async () => {
  if (!lockedToBottom.value) return;
  await nextTick();
  scroller.value?.scrollTo(0, scroller.value.scrollHeight);
});

// Recompute nav button enabled state whenever the timeline grows or the
// session changes — onScroll catches user scrolling, but new content
// arriving while scrolled away from the bottom doesn't fire onScroll.
watch([timeline, () => props.sessionId], async () => {
  await nextTick();
  recomputePromptNav();
});

// Force-scroll on the user's own send action — regardless of where they
// were scrolled to. Trigger:
//   - text/image: drafts.inflightBySession[sid] transitions 0 → ≥1
//
// Smooth scrolling on iOS Safari raced with the real user record
// arriving mid-animation — onScroll fires before scrollTop hits the
// (newly larger) scrollHeight, lockedToBottom flips back to false, and
// the new content is again below the fold. Use instant scroll, then
// re-fire after a few delays so any late-arriving content (the bubble
// → real message swap, the assistant's first text chunk) also lands at
// the bottom.
function snapToBottom() {
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  lockedToBottom.value = true;
}

function forceScrollSoon() {
  void nextTick().then(snapToBottom);
  // Same rAF re-pin loop the session-switch path uses — keeps us glued
  // to the bottom across the late layout shifts that normally beat the
  // fixed-timeout retries (textarea reflow, pending-bubble mount,
  // pending → real message swap, first assistant text chunk,
  // Shiki highlight). Without this the bubble routinely lands below the
  // fold because scrollHeight grows AFTER our scroll.
  //
  // Do not allow the loop to declare stability during the quiet frames before
  // Android starts its keyboard animation. On some Chromium/HyperOS builds
  // the layout viewport changes a few hundred milliseconds after focus.
  pinToBottomUntilStable(1800, 700);
}

defineExpose({ revealLatest: forceScrollSoon });

// Switching sessions reuses this component (no :key in MainPane), so the
// scroller DOM and lockedToBottom state both carry over from the previous
// session — which means scrollTop is meaningless for the new content and
// the user lands at the wrong position. Plus session-cache.restore() is
// async (IndexedDB) and the WebSocket may stream more lines after that,
// so a single nextTick scroll isn't enough.
//
// Fixed-timeout retries (80/250/600/1200 ms) weren't enough on long sessions
// where Vue's render + Shiki highlighting kept growing scrollHeight for
// seconds — by the time the last timeout fired the layout was still mid-
// expansion and the user landed mid-scroll. Replace with a rAF loop that
// re-pins to bottom every frame and stops only after scrollHeight has been
// stable for ~5 consecutive frames, with a 4 s hard cap as backstop.
// Scroll a specific record's element to the top of the viewport, retrying
// across rAF frames while content asynchronously settles (cache restore,
// WS catch-up, render-window expansion, Shiki highlight). Brief CSS flash
// so the user sees WHICH message matched.
//
// If the uuid is outside the initially-rendered window (deep history on
// long sessions, where INITIAL_RENDER_FULL=200 doesn't reach back far
// enough), auto-triggers loadEarlier() to backfill from disk + grow the
// window. Repeats until found or 8 s timeout.
function scrollToUuidUntilStable(uuid: string, maxMs = 8000) {
  const el0 = scroller.value;
  if (!el0 || !uuid) return;
  const start = performance.now();
  let lastTarget = -1;
  let lastHeight = -1;
  let stableFrames = 0;
  let loadInflight = false;
  const sel = `[data-uuid="${CSS.escape(uuid)}"]`;
  const tick = () => {
    const el = scroller.value;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(sel);
    if (target) {
      const toolRun = target.closest(".cw-tool-run") as HTMLElement | null;
      const visualTarget = target.classList.contains("cw-user-prompt-anchor")
        ? (target.nextElementSibling as HTMLElement | null) ?? target
        : toolRun
          ? toolRun
        : target;
      const elRect = el.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      const desired = Math.max(0, el.scrollTop + (r.top - elRect.top) - LAND_OFFSET_PX);
      el.scrollTop = desired;
      if (Math.abs(desired - lastTarget) < 1 && el.scrollHeight === lastHeight) {
        stableFrames++;
        if (stableFrames >= 8) {
          visualTarget.classList.add("cw-match-flash");
          setTimeout(() => visualTarget.classList.remove("cw-match-flash"), 2200);
          lockedToBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX;
          return;
        }
      } else {
        lastTarget = desired;
        lastHeight = el.scrollHeight;
        stableFrames = 0;
      }
    } else if (!loadInflight && canLoadEarlier.value) {
      // Match isn't in the rendered/cached slice yet — pull an older batch
      // (from disk if needed, then expand renderLimit) and keep ticking.
      loadInflight = true;
      void loadEarlier().finally(() => { loadInflight = false; });
    }
    if (performance.now() - start < maxMs) requestAnimationFrame(tick);
    else if (!target) pinToBottomUntilStable(800);
    else lockedToBottom.value = el0.scrollTop + el0.clientHeight >= el0.scrollHeight - NEAR_BOTTOM_PX;
  };
  requestAnimationFrame(tick);
}

// Re-pin to bottom every animation frame until scrollHeight has been
// stable for 12 frames (or 6 s). Handles the slow async pile-up:
// IDB cache restore, WS catch-up, render-window expansion (30 → 200),
// Shiki async highlight, image load — all change scrollHeight after
// mount and a single scrollTo would land at the wrong target.
function pinToBottomUntilStable(maxMs = 6000, minMs = 0) {
  const el0 = scroller.value;
  if (!el0) return;
  let lastScrollHeight = -1;
  let lastClientHeight = -1;
  let stableFrames = 0;
  const start = performance.now();
  const tick = () => {
    const el = scroller.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    if (el.scrollHeight === lastScrollHeight && el.clientHeight === lastClientHeight) {
      stableFrames++;
      if (stableFrames >= 12 && performance.now() - start >= minMs) {
        lockedToBottom.value = true;
        return;
      }
    } else {
      lastScrollHeight = el.scrollHeight;
      lastClientHeight = el.clientHeight;
      stableFrames = 0;
    }
    if (performance.now() - start < maxMs) requestAnimationFrame(tick);
    else lockedToBottom.value = true;
  };
  requestAnimationFrame(tick);
}

// ─── Search-term highlight ────────────────────────────────────────────
// While the sidebar search box has content, paint every occurrence of
// the query (any token) in this session's rendered text yellow. Uses
// the CSS Custom Highlight API — paints over the DOM without mutating
// it, so re-renders (Shiki, markdown, prepend on loadEarlier) don't
// clobber the highlight or get clobbered BY it. Falls back to no-op
// on browsers without the API (Firefox <140); the existing scroll-to
// behaviour still works there.
const SEARCH_HIGHLIGHT_NAME = "cw-search";
const MIN_HIGHLIGHT_TOKEN_LEN = 2;
const MAX_HIGHLIGHT_RANGES = 2000; // safety cap; massive sessions × hot token

function applySearchHighlights() {
  const Highlight = (window as unknown as { Highlight?: new () => { add(r: Range): void } }).Highlight;
  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  if (!Highlight || !highlights) return;
  highlights.delete(SEARCH_HIGHLIGHT_NAME);
  const q = searchHighlight.query.trim().toLowerCase();
  if (!q) return;
  const tokens = q.split(/\s+/).filter((t) => t.length >= MIN_HIGHLIGHT_TOKEN_LEN);
  if (tokens.length === 0) return;
  const root = scroller.value;
  if (!root) return;
  const highlight = new Highlight();
  let added = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // Skip script/style/code-token internals to avoid touching Shiki spans.
      // (Shiki text content is still in text nodes, just usually inside
      // .shiki spans — we DO want to highlight in code blocks.)
      if (parent.closest("script,style")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue ?? "";
    if (!text) continue;
    const lower = text.toLowerCase();
    for (const token of tokens) {
      let from = 0;
      while (added < MAX_HIGHLIGHT_RANGES) {
        const idx = lower.indexOf(token, from);
        if (idx < 0) break;
        try {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + token.length);
          highlight.add(range);
          added++;
        } catch { /* ignore detached nodes */ }
        from = idx + token.length;
      }
      if (added >= MAX_HIGHLIGHT_RANGES) break;
    }
    if (added >= MAX_HIGHLIGHT_RANGES) break;
  }
  highlights.set(SEARCH_HIGHLIGHT_NAME, highlight);
}

let highlightTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleApplySearchHighlights() {
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlightTimer = null;
    applySearchHighlights();
  }, 150);
}

watch(() => searchHighlight.query, scheduleApplySearchHighlights);
watch(() => timeline.value.length, scheduleApplySearchHighlights);
watch(renderLimit, scheduleApplySearchHighlights);
watch([messageDisplayStyle, () => renderedRows.value.length], async () => {
  await nextTick();
  recomputeStickyPrompt();
});

onBeforeUnmount(() => {
  if (highlightTimer) clearTimeout(highlightTimer);
  stickyOverlayRO?.disconnect();
  stickyOverlayRO = null;
  // Clear so the next session's mount starts with no stale ranges
  // pointing at this session's (now detached) DOM.
  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  highlights?.delete(SEARCH_HIGHLIGHT_NAME);
});

// MainPane keys MessageList by sessionId, so this fires once per session
// entry. Default: pin to bottom. If the sidebar's content-search click
// armed a scroll target (uuid of the matching record), scroll to that
// instead — with a brief flash so the user sees which message matched.
onMounted(() => {
  const target = scrollTarget.consume(props.sessionId);
  if (target?.uuid) {
    lockedToBottom.value = false;
    void nextTick().then(() => scrollToUuidUntilStable(target.uuid));
  } else {
    lockedToBottom.value = true;
    void nextTick().then(() => pinToBottomUntilStable());
  }
  if (pendingPrompts.value.length) {
    void nextTick().then(() => {
      pendingPromptEl.value?.scrollIntoView({ block: "end", behavior: "auto" });
    });
  }
  // First highlight pass after the initial mount renders. Subsequent passes
  // are driven by the watchers above as content settles.
  void nextTick().then(applySearchHighlights);
  // After first paint has landed, expand the render window from
  // INITIAL_RENDER_FAST (30) to INITIAL_RENDER_FULL (200) so a single
  // "Load earlier" tap reveals a full screen instead of growing 30 at
  // a time. The auto-pin watcher catches the resulting scrollHeight jump.
  const expand = () => {
    if (renderLimit.value < INITIAL_RENDER_FULL) {
      renderLimit.value = INITIAL_RENDER_FULL;
    }
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(expand, { timeout: 1500 });
  } else {
    setTimeout(expand, 250);
  }
});

watch(() => pendingPrompts.value.length, async (n, old) => {
  if (n <= (old ?? 0)) return;
  forceScrollSoon();
  await nextTick();
  pendingPromptEl.value?.scrollIntoView({ block: "end", behavior: "auto" });
  requestAnimationFrame(() => {
    pendingPromptEl.value?.scrollIntoView({ block: "end", behavior: "auto" });
  });
});

const inflight = computed(() => drafts.inflight(props.sessionId));
watch(inflight, (n, prev) => {
  if ((prev ?? 0) === 0 && n > 0) forceScrollSoon();
});

function recordUuid(entry: { node: TimelineNode }): string {
  if (entry.node.kind !== "event") return "";
  const u = (entry.node.record as { uuid?: unknown }).uuid;
  return typeof u === "string" ? u : "";
}

const stickyPromptOverlayEntry = computed<DecoratedEntry | null>(() => {
  if (messageDisplayStyle.value !== "claude-code") return null;
  const uuid = stickyPromptUuid.value;
  if (!uuid) return null;
  return decorated.value.find((entry) =>
    entry.node.kind === "event" &&
    entry.node.block === "UserPromptBlock" &&
    recordUuid(entry) === uuid,
  ) ?? null;
});

function uuidAttr(entry: { node: TimelineNode }): string | undefined {
  if (entry.node.kind !== "event") return undefined;
  if (entry.node.block === "UserPromptBlock") return undefined;
  return recordUuid(entry) || undefined;
}

function isStickyPromptEntry(entry: { node: TimelineNode }): boolean {
  if (messageDisplayStyle.value === "claude-code") return false;
  if (entry.node.kind !== "event" || entry.node.block !== "UserPromptBlock") return false;
  const uuid = recordUuid(entry);
  return !!uuid && uuid === stickyPromptUuid.value;
}

// Inline transform that evicts the pinned prompt upward as the next one rises.
// Only the currently-pinned prompt gets it; tracks scroll 1:1 (no transition).
function stickyPromptStyle(entry: { node: TimelineNode }): Record<string, string> | undefined {
  if (!isStickyPromptEntry(entry)) return undefined;
  return { transform: `translateY(${-stickyPushPx.value}px)` };
}

function stickyPromptOverlayStyle(): Record<string, string> | undefined {
  if (!stickyPromptOverlayEntry.value) return undefined;
  return { transform: `translateY(${-stickyPushPx.value}px)` };
}

function roleFor(entry: { node: TimelineNode }): string {
  if (entry.node.kind !== "event") return "";
  const rec = entry.node.record as { type?: unknown };
  return typeof rec.type === "string" ? rec.type : "";
}

function isWechatAvatarEntry(entry: { node: TimelineNode }): boolean {
  if (entry.node.kind !== "event") return false;
  if (entry.node.block === "UserPromptBlock") return true;
  if (entry.node.block !== "AssistantBlock") return false;
  const content = (entry.node.record.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) && content.some((b) => {
    const item = b as { type?: unknown; text?: unknown };
    return item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0;
  });
}

function propsFor(entry: { node: TimelineNode; usage: Usage | null }): Record<string, unknown> {
  if (entry.node.kind !== "event") return {};
  if (entry.node.block === "TurnDurationBlock") {
    return { node: entry.node, usage: entry.usage };
  }
  if (entry.node.block === "UserPromptBlock") {
    return { node: entry.node, sessionId: props.sessionId };
  }
  if (entry.node.block === "AssistantBlock") {
    return { node: entry.node };
  }
  return { node: entry.node };
}

// ─── Bubble context menu (right-click on a user/assistant bubble → Copy) ───
// One delegated @contextmenu listener on the scroller instead of a handler
// per bubble; the entry divs already carry data-block + data-uuid. Same
// cw-context-menu styling as SessionRow's menu. Delete is deliberately NOT
// offered: the jsonl is the CLI's transcript — removing a line here would
// desync the CLI's own context and break line-index-based cache/resume.
const notificationsStore = useNotificationsStore();
const bubbleMenu = ref<{ open: boolean; x: number; y: number; uuid: string }>({ open: false, x: 0, y: 0, uuid: "" });

function bubbleTextForUuid(uuid: string): string {
  for (const node of timeline.value) {
    if (node.kind !== "event") continue;
    if ((node.record as { uuid?: unknown }).uuid !== uuid) continue;
    const content = (node.record.message as { content?: unknown } | undefined)?.content;
    let raw = "";
    if (typeof content === "string") raw = content;
    else if (Array.isArray(content)) {
      raw = content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n");
    }
    // User prompts carry the attachment-paths trailer — strip it, same as
    // UserPromptBlock does before rendering.
    return node.block === "UserPromptBlock" ? extractAttachedImages(raw).text : raw;
  }
  return "";
}

function onBubbleContextMenu(e: MouseEvent) {
  // If the user has an active text selection, leave the native menu alone —
  // they're likely going for native copy / lookup on the selected range.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim()) return;
  const target = (e.target as HTMLElement | null)?.closest?.(".cw-message-entry") as HTMLElement | null;
  const block = target?.dataset.block;
  // Not data-uuid: uuidAttr() deliberately omits it for UserPromptBlock
  // (the prompt-anchor div owns that attribute for scroll targeting).
  const uuid = target?.dataset.bubbleUuid;
  if (!target || !uuid || (block !== "UserPromptBlock" && block !== "AssistantBlock")) return;
  if (!bubbleTextForUuid(uuid)) return; // image-only / empty bubble — nothing to copy
  e.preventDefault();
  const menuWidth = 160;
  bubbleMenu.value = {
    open: true,
    x: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, e.clientX)),
    y: Math.min(window.innerHeight - 80, e.clientY),
    uuid,
  };
  setTimeout(() => document.addEventListener("click", closeBubbleMenu), 0);
}

function closeBubbleMenu() {
  bubbleMenu.value.open = false;
  document.removeEventListener("click", closeBubbleMenu);
}

async function copyBubbleText() {
  const text = bubbleTextForUuid(bubbleMenu.value.uuid);
  closeBubbleMenu();
  if (!text) return;
  try {
    await copyText(text);
    notificationsStore.pushInfo("Copied to clipboard");
  } catch (err) {
    notificationsStore.pushError(err instanceof Error ? err.message : String(err), { title: "Copy failed" });
  }
}

onBeforeUnmount(() => document.removeEventListener("click", closeBubbleMenu));
</script>

<template>
  <div
    class="relative flex flex-col min-h-0 cw-message-list"
    :class="messageDisplayClass"
    :data-message-display="messageDisplayStyle"
  >
    <!-- Syncing-latest pill: shown while the on-tap HTTP tail fetch is in
         flight. Floats over the bottom of the list so the cached content stays
         visible underneath; disappears the instant fresh lines land. -->
    <Transition name="cw-sync-pill">
      <div
        v-if="syncingLatest"
        class="cw-sync-pill pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] bg-black/65 text-white shadow"
      >
        <span class="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
        <span>同步最新…</span>
      </div>
    </Transition>
    <div
      v-if="stickyPromptOverlayEntry"
      class="cw-sticky-prompt-overlay-frame"
    >
      <div
        ref="stickyOverlayEl"
        class="cw-sticky-prompt-overlay"
        :style="stickyPromptOverlayStyle()"
      >
        <UserPromptBlock
          :key="recordUuid(stickyPromptOverlayEntry)"
          :node="stickyPromptOverlayEntry.node"
          :session-id="props.sessionId"
          preview
        />
      </div>
    </div>
    <div
      ref="scroller"
      class="cw-message-scroller flex-1 overflow-y-auto overflow-x-hidden overscroll-contain min-h-0"
      @scroll="onScroll"
      @click.capture="onContentClick"
      @contextmenu="onBubbleContextMenu"
    >
      <!-- Pull-to-refresh indicator. Sits above all content and grows in
           height as the user drags down, pushing the rest of the chat
           content with it. transition-none while actively pulling so the
           bar tracks the finger 1:1; CSS transition kicks in on release/
           refresh-end so the snap-back animates. -->
      <div
        class="overflow-hidden flex items-end justify-center text-[12px] opacity-70 select-none pointer-events-none"
        :class="pullState === 'pulling' ? '' : 'transition-[height]  ease-out'"
        :style="{ height: pullDistance + 'px' }"
      >
        <div class="flex items-center gap-1.5 pb-2">
          <span
            v-if="pullState === 'refreshing'"
            class="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
          />
          <span v-else>{{ pullDistance >= PULL_THRESHOLD ? '↑' : '↓' }}</span>
          <span>{{ pullIndicatorLabel }}</span>
        </div>
      </div>
      <button
        v-if="showLoadEarlierButton"
        class="block mx-auto my-2 text-xs px-3 py-1.5 rounded border border-[var(--cw-border)]  opacity-70 hover:opacity-100 disabled:opacity-50 disabled:cursor-default"
        :disabled="loadEarlierInflight"
        @click="loadEarlier('chunk')"
      >{{ loadEarlierInflight ? "Loading…" : "↑ Load earlier" }}</button>
      <template v-for="row in renderedRows" :key="keyForRow(row)">
        <template v-if="row.kind === 'entry'">
        <div
          v-if="row.entry.node.kind === 'event' && row.entry.node.block === 'UserPromptBlock'"
          class="cw-user-prompt-anchor h-px"
          data-user-prompt="true"
          :data-uuid="recordUuid(row.entry)"
          aria-hidden="true"
        />
        <div
          v-if="row.entry.node.kind === 'event' && comp(row.entry.node.block)"
          class="cw-message-entry"
          :class="{ 'cw-sticky-prompt-current': isStickyPromptEntry(row.entry) }"
          :style="stickyPromptStyle(row.entry)"
          :data-block="row.entry.node.block || ''"
          :data-role="roleFor(row.entry)"
          :data-uuid="uuidAttr(row.entry)"
          :data-bubble-uuid="recordUuid(row.entry) || undefined"
        >
          <span
            v-if="row.entry.node.block === 'UserPromptBlock' || row.entry.node.block === 'AssistantBlock'"
            class="cw-message-avatar"
            :class="[
              row.entry.node.block === 'UserPromptBlock' ? 'cw-message-avatar-user' : 'cw-message-avatar-assistant',
              isWechatAvatarEntry(row.entry) ? '' : 'cw-message-avatar-empty',
            ]"
          >
            <!-- Glyph only on the "lead" entry of a turn; other entries keep an
                 empty (transparent) spacer so EVERY bubble in the column stays
                 indented by the avatar slot and the two columns mirror-align.
                 Without the spacer, tool/non-text assistant blocks lose the
                 indent and span full width, breaking the mirror. -->
            <template v-if="isWechatAvatarEntry(row.entry)">
              <template v-if="row.entry.node.block === 'UserPromptBlock'">
                <UserAvatar />
              </template>
              <AgentBadge v-else :agent="agent" :size="28" />
            </template>
          </span>
          <component
          :is="comp(row.entry.node.block)"
          v-bind="propsFor(row.entry)"
          :data-uuid="uuidAttr(row.entry)"
          />
        </div>
        </template>
        <div
          v-else
          class="cw-message-entry"
          data-block="ToolRunBlock"
          data-role="assistant"
        >
          <!-- Same transparent avatar spacer as tool-only assistant entries, so
               a collapsed run indents exactly like a single tool row (WeChat
               shows the avatar column; other displays hide it via CSS). -->
          <span class="cw-message-avatar cw-message-avatar-assistant cw-message-avatar-empty" aria-hidden="true" />
          <ToolRunBlock :items="row.items" />
        </div>
      </template>
      <!-- First-frame user feedback. This is the same UserPromptBlock used by
           durable transcript records, not a visually unrelated queue chip.
           It intentionally has no source anchor/uuid/actions: the real
           JSONL/rollout record takes over once source-index reconciliation
           observes it. Keep it before the thinking row so send order reads
           as user prompt → agent response immediately. -->
      <div
        v-if="pendingPrompts.length"
        ref="pendingPromptEl"
        class="cw-pending-prompts"
        aria-live="polite"
      >
        <div
          v-for="pp in pendingPrompts"
          :key="pp.id"
          class="cw-message-entry cw-message-entry-pending"
          data-block="UserPromptBlock"
          data-role="user"
          :title="pp.steered ? 'Steered into the active turn' : 'Sending'"
        >
          <span class="cw-message-avatar cw-message-avatar-user">
            <UserAvatar />
          </span>
          <UserPromptBlock
            :node="pendingPromptNode(pp)"
            :pending-status="pp.phase === 'sending' ? 'sending' : pp.steered ? 'steered' : undefined"
            :pending-image-count="pp.imageCount"
          />
        </div>
      </div>
      <!-- Compacting writes NOTHING to the jsonl for minutes, which would
           trip the 3-min stall banner — suppress it while compacting and show
           the dedicated label instead so the user knows it's working. -->
      <div
        v-if="running && isStalled && !compacting"
        class="flex items-center gap-2 px-4 py-3 text-sm border-l-4 border-[var(--cw-warning)] bg-[color-mix(in_srgb,var(--cw-warning)_10%,transparent)]"
      >
        <span class="text-[var(--cw-warning)] text-base leading-none" :title="toolInProgress ? 'A command has been running for a very long time' : 'No response in 10+ minutes'">⚠</span>
        <span class="text-[var(--cw-warning)]">{{ toolInProgress ? "A command has been running 12+ minutes — it may be stuck." : "No response in 10+ minutes — upstream may be wedged." }}</span>
        <button
          type="button"
          class="ml-2 text-xs px-2 py-1 rounded bg-[var(--cw-warning)] text-[var(--cw-accent-text)] hover:brightness-95 active:scale-95 transition disabled:opacity-50"
          :disabled="retrying"
          @click="stopAndRetry"
        >{{ retrying ? "Retrying…" : "Stop & retry" }}</button>
      </div>
      <div v-else-if="running || compacting || optimisticallyStarting" class="flex items-center gap-2 px-4 py-3 text-sm opacity-70">
        <span class="thinking-dot bg-current" />
        <span class="thinking-dot bg-current" style="animation-delay: 0.15s" />
        <span class="thinking-dot bg-current" style="animation-delay: 0.3s" />
        <span class="ml-1">{{ compacting ? "🗜 Compacting context…" : toolInProgress ? (runningToolLabel || "⚙ Running a command…") : `${isCodex ? "Codex" : "Claude"} is thinking…` }}</span>
        <span v-if="spinnerElapsed" class="ml-1 opacity-70 tabular-nums">{{ spinnerElapsed }}</span>
      </div>
      <!-- Server-confirmed queue chips: jsonl `queue-operation enqueue`
           records (lands ~140 ms after Send, cleared as a batch on remove /
           dequeue / next assistant). Above the optimistic chips because
           these are guaranteed to be in the CLI's queue. -->
      <!-- Background-task notification that settled mid-turn: show the compact
           summary (same as TaskNotificationBlock) instead of the raw XML. -->
      <div
        v-for="chip in queueChips.filter((c) => c.task)"
        :key="chip.uuid"
        class="cw-task-notification mx-4 my-0.5"
        :class="chip.task!.failed ? 'cw-task-notification-failed text-[var(--cw-danger)]' : ''"
        :title="chip.task!.outputFile || undefined"
      >
        <span class="shrink-0">{{ chip.task!.failed ? '⚠' : '✓' }}</span>
        <span class="flex-1 min-w-0 truncate">{{ chip.task!.summary || 'Background task finished' }}</span>
        <span class="shrink-0 text-[10px] uppercase tracking-wide opacity-60">background</span>
      </div>
      <div
        v-for="chip in queueChips.filter((c) => !c.task)"
        :key="chip.uuid"
        class="cw-queue-chip mx-4 my-1 px-3 py-1.5 rounded-md border text-xs flex items-start gap-2"
        :title="chip.content"
      >
        <span class="opacity-60 shrink-0 leading-5">🕒</span>
        <span class="flex-1 min-w-0 whitespace-pre-wrap break-words">{{ chip.content }}</span>
        <span class="cw-queue-chip-label shrink-0 text-[10px] uppercase tracking-wide leading-5">queued</span>
      </div>
    </div>
    <transition
      enter-active-class="transition-opacity "
      leave-active-class="transition-opacity "
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <button
        v-show="!lockedToBottom"
        class="cw-floating-nav-button cw-scroll-bottom-button absolute bottom-4 right-6 w-10 h-10 rounded-full bg-[var(--cw-panel-bg)] border border-[var(--cw-border)]  shadow-lg text-lg leading-none flex items-center justify-center hover:bg-[var(--cw-panel-2)] z-10"
        @click="scrollToBottom"
        title="Scroll to bottom"
        aria-label="Scroll to bottom"
      >↓</button>
    </transition>
    <!-- Prev/next user-prompt navigator. Vertically centered on the same
         right edge as the scroll-to-bottom button, with the same size and
         border treatment so all three feel like one consistent toolbar
         column. Each button is enabled only when there's somewhere to
         jump to in that direction. -->
    <div
      v-if="navUpEnabled || navDownEnabled"
      class="cw-prompt-nav absolute right-6 top-1/2 -translate-y-1/2 flex flex-col gap-2 z-10"
      data-no-swipe
    >
      <button
        class="cw-floating-nav-button cw-prompt-nav-button w-10 h-10 rounded-full bg-[var(--cw-panel-bg)] border border-[var(--cw-border)]  shadow-lg text-lg leading-none flex items-center justify-center hover:bg-[var(--cw-panel-2)] disabled:opacity-30 disabled:cursor-not-allowed"
        :disabled="!navUpEnabled"
        @click="jumpToPrompt('up')"
        title="Jump to previous prompt"
        aria-label="Previous prompt"
      >↑</button>
      <button
        class="cw-floating-nav-button cw-prompt-nav-button w-10 h-10 rounded-full bg-[var(--cw-panel-bg)] border border-[var(--cw-border)]  shadow-lg text-lg leading-none flex items-center justify-center hover:bg-[var(--cw-panel-2)] disabled:opacity-30 disabled:cursor-not-allowed"
        :disabled="!navDownEnabled"
        @click="jumpToPrompt('down')"
        title="Jump to next prompt"
        aria-label="Next prompt"
      >↓</button>
    </div>
    <Teleport to="body">
      <div
        v-if="bubbleMenu.open"
        class="cw-context-menu fixed z-50 min-w-[160px] rounded-lg border shadow-lg text-sm py-1"
        :style="{ top: bubbleMenu.y + 'px', left: bubbleMenu.x + 'px' }"
        @click.stop
      >
        <button
          class="cw-context-menu-item w-full text-left px-3 py-1.5 flex items-center gap-2"
          @click="void copyBubbleText()"
        >
          <span class="w-4 inline-block text-center">⧉</span>
          Copy text
        </button>
      </div>
    </Teleport>
    <AvatarEditorModal />
  </div>
</template>

<style scoped>
.thinking-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  animation: thinking-bounce 1.2s infinite ease-in-out;
}
@keyframes thinking-bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}
/* Syncing-latest pill fade/slide. */
.cw-sync-pill-enter-active,
.cw-sync-pill-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.cw-sync-pill-enter-from,
.cw-sync-pill-leave-to {
  opacity: 0;
  transform: translate(-50%, 6px);
}
</style>

<!-- Unscoped: the flash class is applied to a descendant block (UserPrompt /
     Assistant / etc.) whose Vue scope ID differs from MessageList's, so a
     scoped rule wouldn't match. The ::highlight() pseudo-element is also
     a global namespace by design, so it goes here too. cw-* prefix to
     avoid colliding with anything else. -->
<style>
@keyframes cw-match-flash {
  0%   { background-color: rgba(250, 204, 21, 0.55); }
  100% { background-color: transparent; }
}
.cw-match-flash {
  animation: cw-match-flash 2s ease-out;
}
/* CSS Custom Highlight API target. Set per-range by applySearchHighlights
   in MessageList. Chrome/Edge 105+, Safari 17.2+, Firefox 140+. Older
   browsers ignore the rule and the page renders unstyled — the scroll-to
   behavior still works there.

   Solid yellow with dark text reads in both light and dark themes; no
   need for a separate dark-mode media query (highlights paint over the
   underlying glyph foreground). */
::highlight(cw-search) {
  background-color: rgb(250 204 21);
  color: rgb(17 24 39);
}
</style>
