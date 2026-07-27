<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useUiStore } from "../stores/ui.js";
import { usePrefsStore } from "../stores/prefs.js";
import { useSessionsStore } from "../stores/sessions.js";
import { useLiveStore } from "../stores/live.js";
import { useNotificationsStore } from "../stores/notifications.js";
import { connected as wsConnected, disconnectedAwhile as wsDisconnectedAwhile, wake as wsWake } from "../api/ws.js";
import MessageList from "./MessageList.vue";
import PromptInput from "./PromptInput.vue";
import PreviewOverlay from "./PreviewOverlay.vue";
import LocalFileViewer from "./LocalFileViewer.vue";
import LocalInfoBubble from "./LocalInfoBubble.vue";
import AgentBadge from "./AgentBadge.vue";
import BackgroundTasksPill from "./BackgroundTasksPill.vue";
import TodoChecklistPill from "./TodoChecklistPill.vue";
import SessionStatusPage from "./SessionStatusPage.vue";
import { usePreviewModalStore } from "../stores/preview-modal.js";
import { useLocalFileViewerStore } from "../stores/local-file-viewer.js";
import { displayCwd } from "../util/cwd-display.js";
import { copyText } from "../util/clipboard.js";
import { getSessionGoal, killSession } from "../api/sessions.js";

const ui = useUiStore();
const prefs = usePrefsStore();
const sessions = useSessionsStore();
const live = useLiveStore();
const notifications = useNotificationsStore();
const preview = usePreviewModalStore();
const localFileViewer = useLocalFileViewerStore();

const sessionId = computed(() => ui.selectedSessionId);
const item = computed(() => (sessionId.value ? sessions.byId[sessionId.value] : null));
const status = computed(() => (sessionId.value ? sessions.statusBySession[sessionId.value] : null));
// True iff a webui-spawned long-lived claude is alive for this session.
// Independent of `status` — an idle long-lived child reads as status=null
// but webuiAlive=true, which is exactly when the Kill pill is most useful.
const webuiAlive = computed(() => !!(
  sessionId.value
  && item.value?.agent === "claude"
  && sessions.webuiAliveBySession[sessionId.value]
));
const isWorking = computed(() => status.value === "running");
// CLI mid-/compact — wire-only signal, the jsonl is silent for the whole
// window. Swaps the green pill's label so the user knows why nothing streams.
const isCompacting = computed(() => !!(sessionId.value && sessions.compactingBySession[sessionId.value]));
const cwdDisplay = computed(() => displayCwd(item.value?.cwd, ui.home));
const title = computed(() => item.value?.title ?? null);
const displayTitle = computed(() => [
  title.value ?? "",
  item.value?.titleEmoji ?? "",
].filter(Boolean).join(" "));
const agent = computed(() => item.value?.agent ?? "claude");
const shortId = computed(() => sessionId.value ? sessionId.value.slice(0, 8) : "");
const isDraft = computed(() => !!sessionId.value && sessions.isPending(sessionId.value));
const mobileHeaderTitle = computed(() => {
  if (isDraft.value) return `New session in ${cwdDisplay.value}`;
  if (isCompacting.value) return "正在整理上下文…";
  if (isWorking.value) return `${agent.value === "codex" ? "Codex" : "Claude"} 正在思考…`;
  return displayTitle.value || `${shortId.value}…`;
});
const goal = computed(() => sessionId.value ? sessions.goalBySession[sessionId.value] ?? null : null);
const goalTitle = computed(() => goal.value
  ? `${goal.value.status}: ${goal.value.objective}\n${goal.value.tokensUsed} tokens used`
  : "");
const goalClass = computed(() => {
  switch (goal.value?.status) {
    case "active":
      return "bg-[color-mix(in_srgb,var(--cw-success)_16%,transparent)] text-[var(--cw-success)]";
    case "paused":
      return "bg-[color-mix(in_srgb,var(--cw-warning)_16%,transparent)] text-[var(--cw-warning)]";
    case "complete":
      return "bg-[var(--cw-panel-2)] text-[var(--cw-muted)]";
    case "blocked":
    case "usageLimited":
    case "budgetLimited":
      return "bg-[color-mix(in_srgb,var(--cw-danger)_16%,transparent)] text-[var(--cw-danger)]";
    default:
      return "bg-[var(--cw-panel-2)] text-[var(--cw-text)]";
  }
});

const GOAL_POLL_MS = 2_000;
let goalFetchSeq = 0;
let goalPollTimer: ReturnType<typeof setTimeout> | undefined;

async function refreshGoal(id: string) {
  const seq = ++goalFetchSeq;
  try {
    const g = await getSessionGoal(id);
    if (seq === goalFetchSeq && sessionId.value === id) sessions.setGoal(id, g);
  } catch (err) {
    if (seq === goalFetchSeq) console.warn(`[goal] fetch failed for ${id}: ${(err as Error).message}`);
  }
}

function stopGoalPolling() {
  if (goalPollTimer) clearTimeout(goalPollTimer);
  goalPollTimer = undefined;
}

async function pollGoal(id: string) {
  await refreshGoal(id);
  if (
    sessionId.value === id
    && agent.value === "codex"
    && status.value === "running"
    && !sessions.isPending(id)
  ) {
    goalPollTimer = setTimeout(() => void pollGoal(id), GOAL_POLL_MS);
  }
}

watch([sessionId, agent, status], ([id, a]) => {
  stopGoalPolling();
  // Invalidate an in-flight fetch from the previously selected session even
  // when the new selection is not a persisted Codex thread.
  goalFetchSeq++;
  if (!id || a !== "codex" || sessions.isPending(id)) return;
  void pollGoal(id);
}, { immediate: true });
onBeforeUnmount(stopGoalPolling);

// The preview belongs to whichever session opened it. Only render its bar
// + iframe when that session is currently selected — switching away hides
// the preview without dropping its state, switching back restores it.
const localFileActive = computed(() => localFileViewer.open && localFileViewer.sessionId === sessionId.value);
const previewActive = computed(() => preview.open && preview.sessionId === sessionId.value && !localFileActive.value);
const previewHref = computed(() => preview.path ? window.location.origin + preview.path : "#");
const retryingReconnect = ref(false);
const statusSheetOpen = ref(false);
const messageListRef = ref<{ revealLatest: () => void } | null>(null);

function revealLatestForMobileKeyboard() {
  messageListRef.value?.revealLatest();
}

// Top-N most recently active sessions, used to populate the empty-state
// landing on desktop so it isn't a dead "pick something from the sidebar"
// blank canvas. mtime-desc is already the order sessions.list comes in.
const recentSessions = computed(() =>
  sessions.list.filter((s) => !sessions.isPending(s.id)).slice(0, 5),
);

watch(sessionId, async (id, prevId) => {
  statusSheetOpen.value = false;
  // Disengage the session we just navigated AWAY from. Only the currently
  // viewed session needs a live per-session tail subscription (its
  // MessageList is the only one mounted — MainPane keys by sessionId).
  // Without this, every session the user ever opened stayed subscribed
  // forever; each one armed the desync watchdog on every global
  // `session-touched`, producing a storm of re-engage + ground-truth
  // stream-truncate churn (especially with many background claude
  // processes all writing their jsonls). Unread/notifications ride the
  // GLOBAL channel, so backgrounded sessions still light the sidebar.
  if (prevId && prevId !== id) live.disengage(prevId);
  // Don't engage live for pending drafts — there's no jsonl on disk to
  // tail and the backend would 404. The first send promotes the draft
  // into a real session and live.engage runs then.
  if (id && !sessions.isPending(id)) await live.engage(id);
}, { immediate: true });

watch(wsConnected, (connected) => {
  if (connected) retryingReconnect.value = false;
});

function retryReconnect() {
  retryingReconnect.value = true;
  wsWake({ forceReconnect: true });
  window.setTimeout(() => { retryingReconnect.value = false; }, 1200);
}

async function killClaude() {
  const id = sessionId.value;
  if (!id) return;
  try {
    await killSession(id);
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Kill failed" });
  }
}

async function copySessionId() {
  const id = sessionId.value;
  if (!id) return;
  try {
    await copyText(id);
    notifications.push({
      uuid: `copy-id-${Date.now()}`,
      sessionId: id,
      cwd: "",
      title: "Copied",
      body: id,
    });
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Copy failed" });
  }
}

async function copyCwd() {
  const path = item.value?.cwd;
  if (!path) return;
  try {
    await copyText(path);
    notifications.push({
      uuid: `copy-cwd-${Date.now()}`,
      sessionId: sessionId.value ?? "",
      cwd: "",
      title: "Copied",
      body: path,
    });
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Copy failed" });
  }
}

</script>

<template>
  <main class="cw-main-pane flex-1 flex flex-col h-full min-h-0 overflow-hidden">
    <template v-if="sessionId && item">
      <!-- Header swaps between session-context bar and preview bar so there's
           only ever one title row, aligned with the sidebar (px-4 py-3). -->
      <header
        v-if="!previewActive"
        class="cw-main-header shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--cw-border)] "
      >
        <!-- Mobile: ← back to chat list. Desktop: hidden (sidebar is
             always visible to the left). Hover styles gated behind
             (hover: hover) so touch devices don't get sticky highlight
             after a tap. -->
        <button
          @click="(e) => { ui.select(null); (e.currentTarget as HTMLElement).blur(); }"
          class="md:hidden w-9 h-9 -ml-2 rounded-full flex items-center justify-center opacity-80 [@media(hover:hover)]:hover:opacity-100 [@media(hover:hover)]:hover:bg-[var(--cw-panel-2)]  active:opacity-75  transition"
          title="Back to chats"
          aria-label="Back to chats"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5">
            <line x1="20" y1="12" x2="4" y2="12" />
            <polyline points="11 5 4 12 11 19" />
          </svg>
        </button>
        <div class="truncate flex-1 min-w-0">
          <div
            class="text-base font-semibold truncate leading-tight"
            :title="displayTitle || `Session ${sessionId}`"
          >
            <span class="md:hidden" :class="{ 'opacity-70 italic': isDraft }">{{ mobileHeaderTitle }}</span>
            <span class="hidden md:inline">
              <template v-if="isDraft"><span class="opacity-70 italic">New session in {{ cwdDisplay }}</span></template>
              <template v-else-if="title">{{ displayTitle }}</template>
              <template v-else><span class="font-mono">{{ shortId }}…</span></template>
            </span>
          </div>
          <div class="text-[11px] opacity-60 leading-tight truncate flex items-center gap-2">
            <AgentBadge :agent="agent" :size="15" label class="shrink-0" />
            <button
              class="truncate min-w-0 text-left hover:opacity-100 hover:underline"
              :title="`Click to copy working directory: ${item.cwd}`"
              @click="copyCwd"
            >{{ cwdDisplay }}</button>
            <button
              v-if="!isDraft"
              class="font-mono opacity-70 shrink-0 hover:opacity-100 hover:underline"
              :title="`Click to copy full session id: ${sessionId}`"
              @click="copySessionId"
            >· {{ shortId }}…</button>
            <span v-else class="shrink-0 italic opacity-70">· draft (type to create)</span>
          </div>
          <div
            v-if="goal && !isDraft"
            class="mt-1 flex items-center gap-1.5 text-[11px] leading-tight min-w-0"
            :title="goalTitle"
          >
            <span :class="['shrink-0 px-1.5 py-0.5 rounded capitalize', goalClass]">{{ goal.status }}</span>
            <span class="truncate opacity-75">Goal: {{ goal.objective }}</span>
          </div>
        </div>
        <div class="hidden md:flex items-center gap-3 shrink-0">
          <!-- Background-work pill: subagents / workflows / background
               shells observed on the CLI wire. Spinner while any run,
               brief green flash + ✓ list on completion. -->
          <BackgroundTasksPill v-if="!isDraft" :session-id="sessionId" />
          <!-- Todo-checklist pill: session task list reconstructed from
               TaskCreate/TaskUpdate lines in the cached transcript. Hidden
               when the session has no tasks. -->
          <TodoChecklistPill v-if="!isDraft" :session-id="sessionId" />
          <!-- Disconnected wins over Thinking on purpose: status is
               backend-pushed over the WS, so "running" goes stale the
               moment the socket dies. Without this priority flip the
               green Thinking pill keeps lying while we have no live
               signal (e.g. after pong-timeout × 2 while claude was
               mid-turn). Reconnect re-pushes status and Thinking comes
               back on its own. -->
          <button
            v-if="wsDisconnectedAwhile || retryingReconnect"
            type="button"
            class="text-xs px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--cw-danger)_16%,transparent)] text-[var(--cw-danger)] [@media(hover:hover)]:hover:bg-[color-mix(in_srgb,var(--cw-danger)_24%,transparent)] active:opacity-75 transition"
            title="Tap to reconnect now"
            @click="retryReconnect"
          >{{ retryingReconnect ? "Reconnecting…" : "Disconnected · tap to retry" }}</button>
          <span
            v-else-if="isWorking || isCompacting"
            class="flex items-center gap-1.5 text-xs px-2 py-0.5 rounded bg-[color-mix(in_srgb,var(--cw-success)_16%,transparent)] text-[var(--cw-success)]"
          >
            <span class="relative flex h-2 w-2">
              <span class="absolute inline-flex h-full w-full rounded-full bg-[var(--cw-success)] opacity-75 animate-ping" />
              <span class="relative inline-flex rounded-full h-2 w-2 bg-[var(--cw-success)]" />
            </span>
            {{ isCompacting ? "Compacting…" : "Thinking…" }}
          </span>
          <!-- Stop button retired — the interrupt pill in PillRow (above the
               textarea) covers the same action and lives next to model /
               permission so all three control surfaces share one row.

               Kill pill is different: it SIGTERMs the long-lived webui-spawned
               claude entirely. Shown whenever we own a live child for this
               session (mid-turn OR idle between turns). The idle case is the
               one PillRow's interrupt can't address — there's nothing to
               interrupt, but the process is still sitting on resources. -->
          <button
            v-if="webuiAlive"
            type="button"
            class="text-xs px-2 py-0.5 rounded bg-[color-mix(in_srgb,var(--cw-danger)_14%,transparent)] text-[var(--cw-danger)] hover:bg-[var(--cw-danger)] hover:text-[var(--cw-accent-text)] transition"
            title="SIGTERM the long-lived webui claude for this session. Next prompt will respawn from scratch."
            @click="killClaude"
          >Kill</button>
        </div>
        <button
          v-if="!isDraft"
          type="button"
          class="md:hidden -mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--cw-text)] active:bg-[var(--cw-panel-2)]"
          :aria-expanded="statusSheetOpen"
          aria-label="会话状态与操作"
          title="会话状态与操作"
          @click="statusSheetOpen = true"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" class="h-5 w-5" aria-hidden="true">
            <circle cx="5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="19" cy="12" r="1.7" />
          </svg>
        </button>
      </header>
      <SessionStatusPage
        v-if="!isDraft"
        :session-id="sessionId"
        :open="statusSheetOpen"
        @close="statusSheetOpen = false"
      />
      <!-- Preview-mode title bar — same height as the session bar above so
           the layout stays still on toggle. Two distinct nav actions:
           ← deselects the session (back to chat list), ✕ only closes the
           preview overlay and returns to the timeline. -->
      <header
        v-else
        class="cw-main-header cw-preview-header shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--cw-border)] "
      >
        <button
          @click="(e) => { ui.select(null); (e.currentTarget as HTMLElement).blur(); }"
          class="md:hidden w-9 h-9 -ml-2 rounded-full flex items-center justify-center opacity-80 [@media(hover:hover)]:hover:opacity-100 [@media(hover:hover)]:hover:bg-[var(--cw-panel-2)]  active:opacity-75  transition shrink-0"
          title="Back to chats"
          aria-label="Back to chats"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5">
            <line x1="20" y1="12" x2="4" y2="12" />
            <polyline points="11 5 4 12 11 19" />
          </svg>
        </button>
        <div class="truncate flex-1 min-w-0">
          <div class="flex items-center gap-2 min-w-0">
            <span class="cw-preview-badge text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0">
              Preview
            </span>
            <span
              class="text-base font-semibold truncate leading-tight"
              :title="preview.summary"
            >{{ preview.summary }}</span>
          </div>
          <div class="text-[11px] opacity-60 leading-tight truncate">
            <template v-if="title">{{ displayTitle }}</template>
            <template v-else-if="isDraft"><span class="italic">New session in {{ cwdDisplay }}</span></template>
            <template v-else><span class="font-mono">{{ shortId }}…</span></template>
            <span class="opacity-60"> · </span>
            <span class="font-mono">{{ preview.path }}</span>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <a
            :href="previewHref"
            target="_blank"
            rel="noopener noreferrer"
            class="w-9 h-9 rounded-full flex items-center justify-center opacity-70 [@media(hover:hover)]:hover:opacity-100 [@media(hover:hover)]:hover:bg-[var(--cw-panel-2)]  transition"
            title="Open in new tab"
            aria-label="Open in new tab"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5">
              <path d="M14 3h7v7" />
              <path d="M10 14L21 3" />
              <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
          </a>
          <button
            type="button"
            class="w-9 h-9 rounded-full flex items-center justify-center opacity-70 [@media(hover:hover)]:hover:opacity-100 [@media(hover:hover)]:hover:bg-[var(--cw-panel-2)]  transition"
            title="Close preview (Esc)"
            aria-label="Close preview"
            @click="preview.close()"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </header>
      <div class="relative flex-1 flex flex-col min-h-0">
        <MessageList
          ref="messageListRef"
          :key="sessionId"
          :session-id="sessionId"
          class="flex-1 min-h-0"
        />
        <PreviewOverlay />
        <LocalFileViewer />
      </div>
      <!-- Client-side system bubble for webui-local slash commands (/help,
           /mcp, /status, …). Never written to the jsonl. -->
      <LocalInfoBubble :session-id="sessionId" />
      <PromptInput
        :session-id="sessionId"
        :running="status === 'running'"
        @mobile-composer-focus="revealLatestForMobileKeyboard"
      />
    </template>
    <template v-else>
      <!-- Empty-state landing — only visible on desktop when no session
           is selected. On mobile the chat list IS this view (MainPane
           hidden via App.vue). Surfaces the 5 most recent sessions as
           click-cards so the user can resume without scanning the
           sidebar; falls back to a "no sessions yet" hint when the list
           is empty (fresh install / wiped storage). -->
      <div class="m-auto px-6 py-8 max-w-xl w-full">
        <div class="flex items-center gap-2 mb-3">
          <h2 class="text-lg font-semibold opacity-90">Recent</h2>
          <button
            v-if="wsDisconnectedAwhile || retryingReconnect"
            type="button"
            class="text-xs px-1.5 py-0.5 rounded bg-[var(--cw-panel-2)] text-[var(--cw-text)]   [@media(hover:hover)]:hover:bg-[var(--cw-panel-2)]  active:opacity-75  transition"
            title="Tap to reconnect now"
            @click="retryReconnect"
          >{{ retryingReconnect ? "Reconnecting…" : "Disconnected · tap to retry" }}</button>
        </div>
        <p v-if="recentSessions.length === 0" class="opacity-60 text-sm">
          No sessions yet. Use ＋ in the sidebar to start one.
        </p>
        <ul v-else class="space-y-1.5">
          <li
            v-for="s in recentSessions"
            :key="s.id"
            class="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer hover:bg-[var(--cw-panel-2)] "
            @click="ui.select(s.id)"
          >
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium truncate">
                <template v-if="s.title">{{ [s.title, s.titleEmoji].filter(Boolean).join(" ") }}</template>
                <template v-else><span class="font-mono opacity-70">{{ s.id.slice(0, 8) }}…</span></template>
              </div>
              <div class="text-[11px] opacity-60 truncate">{{ displayCwd(s.cwd, ui.home) }}</div>
            </div>
          </li>
        </ul>
      </div>
    </template>
  </main>
</template>
