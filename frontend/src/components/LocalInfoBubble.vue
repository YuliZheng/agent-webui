<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "../render/markdown.js";
import { useLocalBubblesStore } from "../stores/local-bubbles.js";

// System-style bubble for webui-local slash-command output (/help, /mcp,
// /status, …). Client-side only — never written to the jsonl, never sent to
// the model. Rendered by MainPane just above the composer so it stays visible
// regardless of scroll position; dismiss with the × button.
const props = defineProps<{ sessionId: string }>();

const bubbles = useLocalBubblesStore();
const bubble = computed(() => bubbles.bySession[props.sessionId] ?? null);
const html = computed(() => (bubble.value && !bubble.value.pending ? renderMarkdown(bubble.value.markdown) : ""));
</script>

<template>
  <div
    v-if="bubble"
    class="cw-local-info-bubble mx-3 mb-1 rounded-lg border border-[var(--cw-border)] bg-[var(--cw-panel-2)] text-sm max-h-[45vh] overflow-y-auto"
  >
    <div class="flex items-center gap-2 px-3 pt-2">
      <span class="text-xs font-semibold uppercase tracking-wide opacity-60">{{ bubble.title }}</span>
      <span class="flex-1" />
      <button
        type="button"
        class="text-[var(--cw-muted)] hover:text-[var(--cw-text)] text-lg leading-none"
        aria-label="Dismiss"
        @click="bubbles.clear(props.sessionId)"
      >×</button>
    </div>
    <div v-if="bubble.pending" class="px-3 pb-3 pt-1 flex items-center gap-2 opacity-70">
      <span class="thinking-dot bg-current" />
      <span class="thinking-dot bg-current" style="animation-delay: 0.15s" />
      <span class="thinking-dot bg-current" style="animation-delay: 0.3s" />
      <span class="text-xs">Fetching…</span>
    </div>
    <div
      v-else-if="bubble.error"
      class="px-3 pb-3 pt-1 text-xs font-mono whitespace-pre-wrap text-[var(--cw-danger)]"
    >{{ bubble.markdown }}</div>
    <div v-else class="px-3 pb-3 pt-1 prose prose-sm dark:prose-invert max-w-none break-words" v-html="html" />
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
</style>
