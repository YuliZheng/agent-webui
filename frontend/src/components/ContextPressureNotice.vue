<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { contextPressureState } from "../util/context-pressure.js";

const props = defineProps<{
  sessionId: string;
  tokens: number;
  limit: number | null;
  working: boolean;
  compacting: boolean;
  compactRequesting: boolean;
}>();

const emit = defineEmits<{
  openStatus: [];
  compactNow: [];
}>();
const state = computed(() => contextPressureState(props.tokens, props.limit, props.compacting));
const dismissed = ref(false);
const dismissalKey = computed(() => `cw:context-pressure-dismissed:${props.sessionId}`);
const show = computed(() => (
  state.value.visible
  && (state.value.tone === "compacting" || !dismissed.value)
));

function storedDismissal(key: string): boolean {
  try { return sessionStorage.getItem(key) === "1"; } catch { return false; }
}

function clearDismissal() {
  dismissed.value = false;
  try { sessionStorage.removeItem(dismissalKey.value); } catch { /* storage unavailable */ }
}

function dismiss() {
  if (state.value.tone === "compacting") return;
  dismissed.value = true;
  try { sessionStorage.setItem(dismissalKey.value, "1"); } catch { /* storage unavailable */ }
}

watch(
  () => props.sessionId,
  () => {
    dismissed.value = storedDismissal(dismissalKey.value);
    if (!state.value.visible) clearDismissal();
  },
  { immediate: true },
);

// A completed compaction drops usage below the warning threshold. That is the
// next context cycle, so a dismissal from the previous cycle must not leak.
watch(
  () => state.value.visible,
  (visible) => { if (!visible) clearDismissal(); },
  { immediate: true },
);
</script>

<template>
  <div
    v-if="show"
    class="cw-context-pressure shrink-0 border-t border-[var(--cw-border)] px-3 py-1.5 sm:py-1 md:px-4"
    :class="`cw-context-pressure-${state.tone}`"
    role="status"
    aria-live="polite"
  >
    <div class="cw-context-pressure-layout mx-auto flex max-w-3xl flex-wrap items-center gap-x-2.5 gap-y-1">
      <span class="cw-context-pressure-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-lg sm:h-6 sm:w-6 sm:rounded-md" aria-hidden="true">
        <svg v-if="state.tone === 'compacting'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 animate-spin">
          <path d="M20 12a8 8 0 1 1-2.34-5.66" />
          <path d="M20 4v6h-6" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
          <path d="M12 3 3.7 18a2 2 0 0 0 1.75 3h13.1a2 2 0 0 0 1.75-3L12 3Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      </span>
      <div class="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-2">
        <div class="text-xs font-semibold leading-snug text-[var(--cw-text)]">{{ state.title }}</div>
        <div class="mt-0.5 text-[11px] leading-snug text-[var(--cw-muted)] sm:mt-0">{{ state.detail }}</div>
      </div>
      <div class="cw-context-pressure-actions flex shrink-0 items-center gap-0.5">
        <button
          v-if="state.tone !== 'compacting' && !working"
          type="button"
          class="cw-context-pressure-compact min-h-11 shrink-0 rounded-lg px-3 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cw-focus-ring)] sm:min-h-9 sm:px-2.5"
          :disabled="compactRequesting"
          :aria-busy="compactRequesting"
          @click="emit('compactNow')"
        >
          <svg v-if="compactRequesting" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="mr-1.5 inline h-3.5 w-3.5 animate-spin" aria-hidden="true">
            <path d="M20 12a8 8 0 1 1-2.34-5.66" />
            <path d="M20 4v6h-6" />
          </svg>
          {{ compactRequesting ? "正在启动…" : "立即整理" }}
        </button>
        <button
          type="button"
          class="min-h-11 shrink-0 rounded-lg px-2.5 text-xs font-medium text-[var(--cw-text)] transition [@media(hover:hover)]:hover:bg-[color-mix(in_srgb,var(--cw-text)_8%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cw-focus-ring)] sm:min-h-9 sm:px-2"
          @click="emit('openStatus')"
        >查看</button>
        <button
          v-if="state.tone !== 'compacting' && !compactRequesting"
          type="button"
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--cw-muted)] transition [@media(hover:hover)]:hover:bg-[color-mix(in_srgb,var(--cw-text)_8%,transparent)] [@media(hover:hover)]:hover:text-[var(--cw-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cw-focus-ring)] sm:h-9 sm:w-9"
          aria-label="关闭本次上下文提醒"
          title="关闭本次提醒"
          @click="dismiss"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" class="h-4 w-4" aria-hidden="true">
            <path d="m5 5 10 10M15 5 5 15" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cw-context-pressure {
  background: color-mix(in srgb, var(--cw-panel-2) 52%, var(--cw-panel-bg));
}
.cw-context-pressure-icon {
  color: var(--cw-warning);
  background: color-mix(in srgb, var(--cw-warning) 10%, transparent);
}
.cw-context-pressure-urgent {
  background: color-mix(in srgb, var(--cw-danger) 4%, var(--cw-panel-bg));
}
.cw-context-pressure-urgent .cw-context-pressure-icon {
  color: var(--cw-danger);
  background: color-mix(in srgb, var(--cw-danger) 12%, transparent);
}
.cw-context-pressure-compacting {
  background: color-mix(in srgb, var(--cw-info) 4%, var(--cw-panel-bg));
}
.cw-context-pressure-compacting .cw-context-pressure-icon {
  color: var(--cw-info);
  background: color-mix(in srgb, var(--cw-info) 12%, transparent);
}
.cw-context-pressure-actions {
  margin-inline-start: auto;
}
.cw-context-pressure-compact {
  color: var(--cw-text);
  border: 1px solid color-mix(in srgb, var(--cw-warning) 24%, var(--cw-border));
  background: color-mix(in srgb, var(--cw-warning) 7%, var(--cw-panel-2));
}
.cw-context-pressure-urgent .cw-context-pressure-compact {
  border-color: color-mix(in srgb, var(--cw-danger) 26%, var(--cw-border));
  background: color-mix(in srgb, var(--cw-danger) 7%, var(--cw-panel-2));
}
.cw-context-pressure-compact:hover:not(:disabled) {
  background: color-mix(in srgb, var(--cw-warning) 13%, var(--cw-panel-2));
}
.cw-context-pressure-urgent .cw-context-pressure-compact:hover:not(:disabled) {
  background: color-mix(in srgb, var(--cw-danger) 13%, var(--cw-panel-2));
}
.cw-context-pressure-compact:disabled {
  cursor: wait;
  opacity: 0.72;
}
@media (max-width: 480px) {
  .cw-context-pressure-layout {
    align-items: flex-start;
  }
  .cw-context-pressure-actions {
    flex-basis: calc(100% - 2.375rem);
    min-width: 0;
    justify-content: flex-end;
    margin-top: 0.125rem;
    margin-inline-start: 2.375rem;
  }
}
</style>
