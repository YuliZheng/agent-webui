<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { CodexGoal } from "../api/sessions.js";
import { APP_BACK_PRIORITY, registerAppBackHandler } from "../util/app-back.js";
import { setPwaLayerActive } from "../util/pwa-history.js";

const props = defineProps<{ sessionId: string; goal: CodexGoal }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
let unregisterAppBack: (() => void) | undefined;

const popoverId = computed(() => `goal-popover-${props.sessionId}`);
const statusLabel = computed(() => ({
  active: "Active",
  complete: "Complete",
  blocked: "Blocked",
  paused: "Paused",
  usageLimited: "Usage limited",
  budgetLimited: "Budget limited",
}[props.goal.status] ?? props.goal.status));
const statusClass = computed(() => {
  switch (props.goal.status) {
    case "active":
      return "bg-[color-mix(in_srgb,var(--cw-success)_16%,transparent)] text-[var(--cw-success)]";
    case "blocked":
    case "usageLimited":
    case "budgetLimited":
      return "bg-[color-mix(in_srgb,var(--cw-danger)_16%,transparent)] text-[var(--cw-danger)]";
    case "paused":
      return "bg-[color-mix(in_srgb,var(--cw-warning)_16%,transparent)] text-[var(--cw-warning)]";
    default:
      return "bg-[var(--cw-panel-2)] text-[var(--cw-muted)]";
  }
});
const tokenSummary = computed(() => {
  const used = props.goal.tokensUsed;
  const budget = props.goal.tokenBudget;
  if (used == null && budget == null) return "";
  const format = (value: number) => new Intl.NumberFormat("en-US").format(value);
  if (budget != null) return `${format(used ?? 0)} / ${format(budget)} tokens`;
  return `${format(used ?? 0)} tokens used`;
});

function close() {
  open.value = false;
}

function toggle() {
  open.value = !open.value;
}

function onDocumentClick(event: MouseEvent) {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (target && root.value?.contains(target)) return;
  close();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !open.value) return;
  event.preventDefault();
  close();
}

watch(open, value => {
  setPwaLayerActive(`goal-popover:${props.sessionId}`, value, props.sessionId);
});
watch(() => props.sessionId, close);

onMounted(() => {
  unregisterAppBack = registerAppBackHandler(() => {
    if (!open.value) return false;
    close();
    return true;
  }, APP_BACK_PRIORITY.menu);
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", close);
});

onBeforeUnmount(() => {
  setPwaLayerActive(`goal-popover:${props.sessionId}`, false, props.sessionId);
  unregisterAppBack?.();
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", close);
});
</script>

<template>
  <div ref="root" class="relative shrink-0 md:hidden">
    <button
      type="button"
      class="flex h-6 items-center gap-1.5 rounded-full border border-[var(--cw-border)] bg-[var(--cw-panel-2)] px-2 text-[10px] font-medium text-[var(--cw-text)] active:opacity-70"
      :class="{ 'ring-2 ring-[color-mix(in_srgb,var(--cw-accent)_36%,transparent)]': open }"
      aria-label="查看 Goal"
      aria-haspopup="dialog"
      :aria-controls="popoverId"
      :aria-expanded="open"
      @click="toggle"
    >
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full"
        :class="goal.status === 'active' ? 'bg-[var(--cw-success)]' : goal.status === 'blocked' ? 'bg-[var(--cw-danger)]' : 'bg-[var(--cw-muted)]'"
        aria-hidden="true"
      />
      <span>Goal</span>
    </button>

    <Transition name="cw-goal-popover">
      <section
        v-if="open"
        :id="popoverId"
        role="dialog"
        aria-label="Goal 详情"
        class="absolute right-[-2.5rem] top-[calc(100%+0.5rem)] z-50 max-h-[min(22rem,calc(100dvh-5rem))] w-[min(18rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-[var(--cw-popover-border,var(--cw-border))] bg-[var(--cw-popover-bg,var(--cw-panel-bg))] p-3 text-left shadow-[var(--cw-popover-shadow,0_10px_30px_rgba(0,0,0,0.16))]"
      >
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-sm font-semibold text-[var(--cw-text)]">Goal</h2>
          <span :class="['shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', statusClass]">
            {{ statusLabel }}
          </span>
        </div>
        <p class="mt-2 break-words text-sm leading-5 text-[var(--cw-text)]">
          {{ goal.objective }}
        </p>
        <p v-if="tokenSummary" class="mt-2 text-[11px] text-[var(--cw-muted)]">
          {{ tokenSummary }}
        </p>
      </section>
    </Transition>
  </div>
</template>

<style scoped>
.cw-goal-popover-enter-active,
.cw-goal-popover-leave-active {
  transition: opacity 0.14s ease, transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.cw-goal-popover-enter-from,
.cw-goal-popover-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
@media (prefers-reduced-motion: reduce) {
  .cw-goal-popover-enter-active,
  .cw-goal-popover-leave-active {
    transition: none;
  }
}
</style>
