<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ArrowLeft, CheckCircle2, Download, LoaderCircle, Minimize2, MoreHorizontal, Octagon, Pencil, Target, Trash2, XCircle } from "lucide-vue-next";
import AgentLogo from "@/components/AgentLogo.vue";
import type { BackgroundTask, SessionListItem, SessionStatus } from "@/types";
import { mainSocket } from "@/api/ws";
import { exportUrl } from "@/api/http";
import { useUiStore } from "@/stores/ui";
import { sessionAppearance } from "@/util/session-appearance";
const props = withDefaults(defineProps<{
  session: SessionListItem;
  status?: SessionStatus;
  backgroundTasks?: BackgroundTask[];
}>(), { backgroundTasks: () => [] });
const emit = defineEmits<{ back: []; refresh: []; renamed: [title: string] }>();
const ui = useUiStore();
const goalSupported = ref(props.session.agent === "codex");
const goalLoaded = ref(false);
const goalLoading = ref(false);
const goalData = ref<{ objective: string; status?: string; tokenBudget?: number } | null>(null);
const goal = computed(() => goalData.value?.objective ?? null);
const hasGoal = computed(() => Boolean(goal.value?.trim()));
const appearance = computed(() => sessionAppearance(props.session.cwd, props.session.agent, props.session.id));
const displayTitle = computed(() => props.session.title || props.session.cwd.split(/[\\/]/).filter(Boolean).pop() || "Untitled");
const shortSessionId = computed(() => props.session.id.length > 10 ? `${props.session.id.slice(0, 8)}…` : props.session.id);
const tasksOpen = ref(false); const completedFlash = ref(false); let completedTimer: ReturnType<typeof setTimeout> | undefined;
const overflowOpen = ref(false);
const overflowButton = ref<HTMLButtonElement | null>(null);
const overflowMenu = ref<HTMLElement | null>(null);
const overflowPosition = ref({ left: 8, top: 8 });
let goalLoadSequence = 0;
const runningTasks = computed(() => props.backgroundTasks.filter((task) => task.status === "running"));
const failedTasks = computed(() => props.backgroundTasks.filter((task) => task.status === "failed" || task.status === "cancelled"));
async function copyMetadata(value: string, label: "Path" | "Session ID") {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    try {
      textarea.select();
      if (!document.execCommand("copy")) throw new Error("Copy command failed");
    } catch {
      ui.toast(`Could not copy ${label.toLowerCase()}`, "error");
      return;
    } finally {
      textarea.remove();
    }
  }
  ui.toast(`${label} copied`);
}
function closeOverflow(returnFocus = false) {
  overflowOpen.value = false;
  if (returnFocus) void nextTick(() => overflowButton.value?.focus());
}
function openOverflow(focusFirst = false) {
  const rect = overflowButton.value?.getBoundingClientRect();
  if (rect) {
    const menuWidth = 180;
    overflowPosition.value = {
      left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      top: rect.bottom + 4
    };
  }
  overflowOpen.value = true;
  if (props.session.agent === "codex") void loadGoal();
  if (focusFirst) void nextTick(() => overflowMenu.value?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
}
function toggleOverflow() { if (overflowOpen.value) closeOverflow(); else openOverflow(); }
function onOverflowButtonKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && overflowOpen.value) { event.preventDefault(); closeOverflow(); return; }
  if (!["ArrowDown", "Enter", " "].includes(event.key)) return;
  event.preventDefault();
  if (!overflowOpen.value) openOverflow(true);
  else void nextTick(() => overflowMenu.value?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
}
function onOverflowKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") { event.preventDefault(); closeOverflow(true); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = [...(overflowMenu.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
  if (!buttons.length) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0
    : event.key === "End" ? buttons.length - 1
    : event.key === "ArrowUp" ? (current <= 0 ? buttons.length - 1 : current - 1)
    : (current + 1) % buttons.length;
  buttons[next]?.focus();
}
function compactSession() { closeOverflow(); void mainSocket.request("compact-session", { sessionId: props.session.id }); }
function killOwned() { closeOverflow(); if (window.confirm("Kill the WebUI-owned process?")) void mainSocket.request("kill", { sessionId: props.session.id }); }
async function rename() { const title = window.prompt("Session title", props.session.title ?? ""); if (title == null) return; await mainSocket.request("set-title", { sessionId: props.session.id, title }); emit("renamed", title); }
function normalizeGoal(value: unknown): { objective: string; status?: string; tokenBudget?: number } | null {
  if (typeof value === "string") return { objective: value };
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>; if (typeof record.objective !== "string") return null;
  return { objective: record.objective, ...(typeof record.status === "string" ? { status: record.status } : {}), ...(typeof record.tokenBudget === "number" ? { tokenBudget: record.tokenBudget } : {}) };
}
async function editGoal() {
  closeOverflow();
  await loadGoal();
  if (!goalSupported.value) return;
  const value = window.prompt("Codex goal (empty clears)", goal.value ?? ""); if (value == null) return;
  const objective = value.trim();
  const args = objective ? { sessionId: props.session.id, objective, status: goalData.value?.status ?? "active", ...(goalData.value?.tokenBudget ? { tokenBudget: goalData.value.tokenBudget } : {}) } : { sessionId: props.session.id };
  const result = await mainSocket.request<{ goal: unknown }>(objective ? "codex-goal-set" : "codex-goal-clear", args); goalData.value = normalizeGoal(result.goal);
}
async function clearGoal() {
  closeOverflow();
  const result = await mainSocket.request<{ goal: unknown }>("codex-goal-clear", { sessionId: props.session.id });
  goalData.value = normalizeGoal(result.goal);
}
async function loadGoal() {
  if (goalLoaded.value || goalLoading.value) return;
  const sequence = ++goalLoadSequence; const sessionId = props.session.id;
  if (props.session.agent !== "codex") { goalSupported.value = false; goalLoaded.value = true; return; }
  goalLoading.value = true;
  try {
    const result = await mainSocket.request<{ goal: unknown }>("codex-goal-get", { sessionId });
    if (sequence !== goalLoadSequence || sessionId !== props.session.id) return;
    goalSupported.value = true;
    goalData.value = normalizeGoal(result.goal);
  } catch {
    if (sequence === goalLoadSequence) goalSupported.value = false;
  } finally {
    if (sequence === goalLoadSequence) {
      goalLoaded.value = true;
      goalLoading.value = false;
    }
  }
}
watch(() => [props.session.id, props.session.agent], () => {
  goalLoadSequence++;
  goalSupported.value = props.session.agent === "codex";
  goalLoaded.value = false;
  goalLoading.value = false;
  goalData.value = null;
  tasksOpen.value = false;
  overflowOpen.value = false;
}, { immediate: true });
watch(() => props.backgroundTasks.map((task) => `${task.id}:${task.status}`).join("|"), (current, previous) => {
  const before = new Set(previous.split("|").filter((item) => item.endsWith(":completed")).map((item) => item.slice(0, -10)));
  const completed = current.split("|").filter((item) => item.endsWith(":completed")).map((item) => item.slice(0, -10));
  if (completed.some((id) => !before.has(id))) { completedFlash.value = true; clearTimeout(completedTimer); completedTimer = setTimeout(() => { completedFlash.value = false; }, 1800); }
});
onBeforeUnmount(() => clearTimeout(completedTimer));
</script>
<template>
  <header class="cw-main-header">
    <button class="cw-mobile-back" title="Back to chats" aria-label="Back to chats" @click="emit('back')"><ArrowLeft :size="20" /></button>
    <span class="cw-header-session-icon" :style="{ '--cw-session-accent': appearance.color, backgroundColor: appearance.color }">{{ session.titleEmoji || appearance.emoji }}</span>
    <div class="cw-header-title">
      <strong>{{ displayTitle }}</strong>
      <small class="cw-header-session-meta">
        <span class="cw-header-agent-mark" :class="`is-${session.agent}`">
          <AgentLogo :agent="session.agent" />
        </span>
        <span>{{ session.agent === 'codex' ? 'Codex' : 'Claude' }}</span>
        <span class="cw-header-meta-separator" aria-hidden="true">·</span>
        <button
          class="cw-header-copyable cw-header-cwd"
          type="button"
          data-testid="copy-session-path"
          :title="`Copy path: ${session.cwd}`"
          :aria-label="`Copy path ${session.cwd}`"
          @click="copyMetadata(session.cwd, 'Path')"
        >{{ session.cwd }}</button>
        <span class="cw-header-meta-separator" aria-hidden="true">·</span>
        <button
          class="cw-header-copyable cw-header-session-id"
          type="button"
          data-testid="copy-session-id"
          :title="`Copy session ID: ${session.id}`"
          :aria-label="`Copy session ID ${session.id}`"
          @click="copyMetadata(session.id, 'Session ID')"
        >{{ shortSessionId }}</button>
      </small>
    </div>
    <div class="cw-header-actions">
      <button v-if="backgroundTasks.length" class="cw-background-pill" :class="{ 'has-failed': failedTasks.length, completed: completedFlash }" title="Background tasks" @click="tasksOpen = true">
        <LoaderCircle v-if="runningTasks.length" class="cw-spin" :size="14" />
        <XCircle v-else-if="failedTasks.length" :size="14" />
        <CheckCircle2 v-else :size="14" />
        {{ runningTasks.length || backgroundTasks.length }}
      </button>
      <button title="Rename session" aria-label="Rename session" @click="rename"><Pencil :size="17" /></button>
      <a :href="exportUrl(session.id)" title="Export session" aria-label="Export session"><Download :size="18" /></a>
      <span v-if="hasGoal" class="cw-header-goal-indicator" title="Codex goal set" aria-hidden="true">•</span>
      <button ref="overflowButton" title="Session actions" :aria-label="hasGoal ? 'Session actions; Codex goal set' : 'Session actions'" aria-haspopup="menu" :aria-expanded="overflowOpen" @click="toggleOverflow" @keydown="onOverflowButtonKeydown">
        <MoreHorizontal :size="20" />
      </button>
    </div>
  </header>
  <Teleport to="body"><template v-if="overflowOpen">
    <button class="cw-popover-scrim" aria-label="Close session actions" @click="closeOverflow(true)" />
    <div ref="overflowMenu" class="cw-action-popover cw-session-context cw-context-menu" role="menu" aria-label="Session actions" :style="{ left: `${overflowPosition.left}px`, top: `${overflowPosition.top}px` }" @keydown="onOverflowKeydown">
      <button class="cw-context-menu-item" role="menuitem" :disabled="status?.compacting" @click="compactSession"><Minimize2 :size="15" />{{ status?.compacting ? 'Compacting…' : 'Compact session' }}</button>
      <button v-if="goalSupported" class="cw-context-menu-item" role="menuitem" :disabled="goalLoading" @click="editGoal"><LoaderCircle v-if="goalLoading" class="cw-spin" :size="15" /><Target v-else :size="15" />{{ goalLoading ? 'Loading Codex goal…' : hasGoal ? 'Edit Codex goal…' : 'Set Codex goal…' }}</button>
      <button v-if="goalSupported && hasGoal" class="cw-context-menu-item" role="menuitem" @click="clearGoal"><Trash2 :size="15" />Clear Codex goal</button>
      <button v-if="status?.webuiAlive" class="danger cw-context-menu-item" role="menuitem" @click="killOwned"><Octagon :size="15" />Kill owned process</button>
    </div>
  </template></Teleport>
  <Teleport to="body"><div v-if="tasksOpen" class="cw-modal-scrim cw-modal-overlay" @click.self="tasksOpen = false"><section class="cw-modal cw-modal-card cw-task-modal">
    <header><h2>Background tasks</h2><button @click="tasksOpen = false">Close</button></header>
    <article v-for="task in backgroundTasks" :key="task.id" :class="`is-${task.status}`">
      <LoaderCircle v-if="task.status === 'running'" class="cw-spin" :size="15" /><CheckCircle2 v-else-if="task.status === 'completed'" :size="15" /><XCircle v-else :size="15" />
      <div><strong>{{ task.title || task.id }}</strong><small>{{ task.status }}<template v-if="task.progress != null"> · {{ Math.round(task.progress) }}%</template></small><p v-if="task.description || task.detail">{{ task.description || task.detail }}</p><pre v-if="task.error || task.output">{{ task.error || task.output }}</pre></div>
    </article>
  </section></div></Teleport>
</template>
