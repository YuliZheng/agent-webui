<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import type { BackgroundTask } from "@claude-webui/shared/api";
import { useBackgroundTasksStore } from "../stores/background-tasks.js";
import { useSessionsStore } from "../stores/sessions.js";
import { nowMs, formatElapsed } from "../util/now-tick.js";
import { currentTurnBackgroundTasks, runtimeBackgroundTasks } from "../util/runtime-work.js";

// Compact header pill showing real subagent work for the current session.
// Internal plans, background shells, and completed history stay out of the
// header. A finished subagent flashes briefly, then the pill disappears.
const props = defineProps<{ sessionId: string }>();

const store = useBackgroundTasksStore();
const sessions = useSessionsStore();
const tasks = computed(() => currentTurnBackgroundTasks(
  runtimeBackgroundTasks(
    store.tasks(props.sessionId),
    sessions.list,
    sessions.statusBySession,
    props.sessionId,
  ),
  sessions.byId[props.sessionId]?.agent === "codex"
    ? sessions.byId[props.sessionId]?.lastBoundaryAt
    : undefined,
).filter((task) => task.kind === "agent"));
const running = computed(() => tasks.value.filter((t) => t.status === "running"));
const recentlyCompleted = ref<BackgroundTask | null>(null);
const flash = computed(() => recentlyCompleted.value !== null);
const displayTasks = computed(() => running.value.length > 0
  ? running.value
  : recentlyCompleted.value
    ? [recentlyCompleted.value]
    : []);
const open = ref(false);
let completionTimer: ReturnType<typeof setTimeout> | undefined;

// Initial load per session view; live updates ride the global WS channel.
watch(() => props.sessionId, (id) => {
  open.value = false;
  if (id) void store.fetch(id);
}, { immediate: true });

const label = computed(() => {
  const n = running.value.length;
  if (n === 1) return running.value[0]!.label;
  return `${n} subagents`;
});

watch(tasks, (next, previous) => {
  const nextRunning = new Set(next.filter((task) => task.status === "running").map((task) => task.taskId));
  const finished = previous.find((task) => (
    task.status === "running" && !nextRunning.has(task.taskId)
  ));
  if (!finished) return;
  recentlyCompleted.value = next.find((task) => task.taskId === finished.taskId) ?? {
    ...finished,
    status: "completed",
    completedAt: new Date().toISOString(),
  };
  if (completionTimer) clearTimeout(completionTimer);
  completionTimer = setTimeout(() => {
    recentlyCompleted.value = null;
    completionTimer = undefined;
    open.value = false;
  }, 2_500);
});

const KIND_ICON: Record<string, string> = { agent: "🤖", workflow: "⚙️", shell: "＄", cron: "⏰" };

function elapsedOf(t: { startedAt: string; completedAt?: string; status: string }): string {
  const start = Date.parse(t.startedAt);
  if (!Number.isFinite(start)) return "";
  const end = t.status === "running" ? nowMs.value : Date.parse(t.completedAt ?? "") || nowMs.value;
  return formatElapsed(end - start);
}

function onDocClick(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest?.(".cw-bg-tasks-pill")) open.value = false;
}
watch(open, (o) => {
  if (o) setTimeout(() => document.addEventListener("click", onDocClick), 0);
  else document.removeEventListener("click", onDocClick);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  if (completionTimer) clearTimeout(completionTimer);
});
</script>

<template>
  <div v-if="running.length > 0 || flash" class="cw-bg-tasks-pill relative">
    <button
      type="button"
      class="flex items-center gap-1.5 text-xs px-2 py-0.5 rounded transition"
      :class="flash
        ? 'bg-[color-mix(in_srgb,var(--cw-success)_22%,transparent)] text-[var(--cw-success)]'
        : running.length > 0
          ? 'bg-[color-mix(in_srgb,var(--cw-info)_16%,transparent)] text-[var(--cw-info)] [@media(hover:hover)]:hover:bg-[color-mix(in_srgb,var(--cw-info)_24%,transparent)]'
          : 'bg-[var(--cw-panel-2)] text-[var(--cw-muted)] [@media(hover:hover)]:hover:text-[var(--cw-text)]'"
      :title="running.length > 0 ? 'Subagents running — click for details' : 'Subagent finished — click for details'"
      @click="open = !open"
    >
      <span v-if="running.length > 0" class="inline-block animate-spin leading-none">⟳</span>
      <span v-else class="leading-none text-[var(--cw-success)]">✓</span>
      <span class="max-w-[160px] truncate">{{ running.length > 0 ? label : "Subagent finished" }}</span>
    </button>
    <!-- Dropdown: one row per task, running first (list order is launch order). -->
    <div
      v-if="open"
      class="absolute right-0 top-full mt-1 z-50 min-w-[240px] max-w-[320px] rounded-lg border border-[var(--cw-border)]  bg-[var(--cw-panel-bg)] shadow-lg text-sm py-1"
    >
      <div
        v-for="t in displayTasks"
        :key="t.taskId"
        class="px-3 py-1.5 flex items-center gap-2 min-w-0"
      >
        <span class="shrink-0 text-xs w-4 text-center" :title="t.kind">{{ KIND_ICON[t.kind] ?? "•" }}</span>
        <span class="flex-1 min-w-0 truncate" :title="t.label">{{ t.label }}</span>
        <span class="shrink-0 text-[11px] opacity-60 tabular-nums">{{ elapsedOf(t) }}</span>
        <span v-if="t.status === 'running'" class="shrink-0 inline-block animate-spin text-[var(--cw-info)] leading-none">⟳</span>
        <span v-else-if="t.status === 'completed'" class="shrink-0 text-[var(--cw-success)] leading-none">✓</span>
        <span v-else class="shrink-0 text-[var(--cw-danger)] leading-none" title="Failed">✗</span>
      </div>
    </div>
  </div>
</template>
