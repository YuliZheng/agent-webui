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
    <div v-if="showThinking && thinkingItems.length" class="cw-thinking">
      <pre v-for="(text, index) in thinkingItems" :key="index">{{ text }}</pre>
    </div>
    <div v-if="contentText" class="cw-assistant-text prose" v-html="renderMarkdown(contentText)" />
  </div>
</template>
