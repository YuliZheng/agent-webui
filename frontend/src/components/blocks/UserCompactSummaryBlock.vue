<script setup lang="ts">
import { ref, computed } from "vue";
import { renderMarkdown } from "../../render/markdown.js";

const props = defineProps<{ node: { record: Record<string, unknown> } }>();
const open = ref(false);
const text = computed(() => {
  const m = (props.node.record.message as { content?: unknown } | undefined)?.content;
  return typeof m === "string" ? m : Array.isArray(m) ? m.map((b: any) => b?.text ?? "").join("\n") : "";
});
const html = computed(() => renderMarkdown(text.value));
</script>

<template>
  <div class="cw-compact-summary rounded-xl border px-4 py-2">
    <button
      type="button"
      class="cw-compact-summary-toggle flex w-full items-center gap-1.5 text-left text-xs font-medium transition"
      :aria-expanded="open"
      @click="open = !open"
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5 transition-transform" :class="open ? 'rotate-90' : ''" aria-hidden="true">
        <path d="m7 4 6 6-6 6" />
      </svg>
      <span>查看较早内容摘要</span>
    </button>
    <div v-if="open" class="prose prose-sm dark:prose-invert mt-2 max-h-96 max-w-none overflow-y-auto break-words" v-html="html" />
  </div>
</template>
