<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useSessionCacheStore } from "../stores/session-cache.js";
import { runtimeChecklist, type RuntimeChecklistItem } from "../util/runtime-work.js";

// Compact header pill showing explicit Claude TaskCreate/TaskUpdate objects.
// Codex update_plan is intentionally not surfaced here; the important Codex
// runtime signal is the separate subagent/background-work pill.
// State is reconstructed client-side from the cached jsonl lines (same source
// the timeline renders from) — no backend involvement:
//   - TaskCreate results carry toolUseResult.task = { id, subject }
//   - TaskUpdate tool_use inputs carry { taskId, status?, subject? }
// Visual sibling of BackgroundTasksPill: collapsed pill, click for dropdown.
const props = defineProps<{ sessionId: string }>();
const cache = useSessionCacheStore();
const open = ref(false);

watch(() => props.sessionId, () => { open.value = false; });

const tasks = computed<RuntimeChecklistItem[]>(() => {
  const lines = cache.bySession[props.sessionId]?.lines ?? [];
  return runtimeChecklist(lines);
});

const live = computed(() => tasks.value.filter((t) => t.status !== "deleted"));
const doneCount = computed(() => live.value.filter((t) => t.status === "completed").length);
const anyInProgress = computed(() => live.value.some((t) => t.status === "in_progress"));

const GLYPH: Record<string, string> = {
  pending: "☐",
  in_progress: "◐",
  completed: "☑",
  deleted: "☒",
};

function onDocClick(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest?.(".cw-todo-pill")) open.value = false;
}
watch(open, (o) => {
  if (o) setTimeout(() => document.addEventListener("click", onDocClick), 0);
  else document.removeEventListener("click", onDocClick);
});
onBeforeUnmount(() => document.removeEventListener("click", onDocClick));
</script>

<template>
  <div v-if="live.length > 0" class="cw-todo-pill relative">
    <button
      type="button"
      class="flex items-center gap-1.5 text-xs px-2 py-0.5 rounded transition"
      :class="anyInProgress
        ? 'bg-[color-mix(in_srgb,var(--cw-info)_16%,transparent)] text-[var(--cw-info)] [@media(hover:hover)]:hover:bg-[color-mix(in_srgb,var(--cw-info)_24%,transparent)]'
        : 'bg-[color-mix(in_srgb,var(--cw-success)_14%,transparent)] text-[var(--cw-success)] [@media(hover:hover)]:hover:bg-[color-mix(in_srgb,var(--cw-success)_22%,transparent)]'"
      title="Session task list — click for details"
      @click="open = !open"
    >
      <span class="leading-none">☑</span>
      <span class="tabular-nums">{{ doneCount }}/{{ live.length }}</span>
    </button>
    <div
      v-if="open"
      class="absolute right-0 top-full mt-1 z-50 min-w-[240px] max-w-[320px] rounded-lg border border-[var(--cw-border)]  bg-[var(--cw-panel-bg)] shadow-lg text-sm py-1"
    >
      <div
        v-for="t in tasks"
        :key="t.id"
        class="px-3 py-1.5 flex items-center gap-2 min-w-0"
      >
        <span class="shrink-0 text-xs w-4 text-center opacity-80" :title="t.status">{{ GLYPH[t.status] ?? "☐" }}</span>
        <span
          class="flex-1 min-w-0 truncate"
          :class="t.status === 'deleted' ? 'line-through opacity-50'
            : t.status === 'completed' ? 'opacity-60'
            : ''"
          :title="t.subject"
        >{{ t.subject }}</span>
      </div>
    </div>
  </div>
</template>
