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
  <div class="cw-compact-summary px-4 py-2 border-l-4">
    <button
      type="button"
      class="cw-compact-summary-toggle flex items-center gap-1.5 text-xs font-medium transition"
      @click="open = !open"
    >
      <span class="inline-block transition-transform" :class="open ? 'rotate-90' : ''">▸</span>
      <span>📄 Summary of earlier conversation</span>
    </button>
    <div v-if="open" class="prose prose-sm dark:prose-invert max-w-none break-words mt-2" v-html="html" />
  </div>
</template>
