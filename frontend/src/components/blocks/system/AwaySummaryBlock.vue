<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "../../../render/markdown.js";

const props = defineProps<{ node: { record: Record<string, unknown> } }>();
const text = computed(() => String((props.node.record as any).content ?? ""));
const html = computed(() => renderMarkdown(text.value));
</script>
<template>
  <div class="px-4 py-2 border-l-4 border-[var(--cw-info)] bg-[color-mix(in_srgb,var(--cw-info)_8%,transparent)]">
    <div class="text-xs uppercase tracking-wider opacity-60 mb-1">Recap</div>
    <div class="prose prose-sm dark:prose-invert max-w-none break-words" v-html="html" />
  </div>
</template>
