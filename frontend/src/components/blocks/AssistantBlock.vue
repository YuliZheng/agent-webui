<script setup lang="ts">
import { computed, ref } from "vue";
import type { NormalizedBlock } from "@/types";
import { renderMarkdown } from "@/render/markdown";

const props = defineProps<{ block: NormalizedBlock }>();
const showThinking = ref(false);
const thinkingItems = computed(() => props.block.kind === "thinking" && props.block.text?.trim() ? [props.block.text] : []);
const contentText = computed(() => props.block.kind === "thinking" ? "" : props.block.text ?? "");
</script>

<template>
  <div class="cw-block cw-assistant-block">
    <button
      v-if="thinkingItems.length"
      type="button"
      class="cw-thinking-fold"
      :aria-expanded="showThinking"
      :title="showThinking ? 'Hide thinking' : `Show thinking (${thinkingItems.reduce((n, text) => n + text.length, 0)} chars)`"
      @click="showThinking = !showThinking"
    >✻ {{ thinkingItems.length }}</button>
    <div v-if="showThinking && thinkingItems.length" class="cw-thinking px-4 py-2">
      <pre v-for="(text, index) in thinkingItems" :key="index" class="text-xs whitespace-pre-wrap break-words font-sans opacity-60">{{ text }}</pre>
    </div>
    <div
      v-if="contentText"
      v-code-fences
      class="cw-assistant-text px-4 py-2 border-l-4 prose prose-sm dark:prose-invert max-w-none break-words border-emerald-400 dark:border-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/30"
      v-html="renderMarkdown(contentText)"
    />
  </div>
</template>
