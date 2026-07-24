<script setup lang="ts">
import { computed, ref } from "vue";
import type { NormalizedBlock } from "@/types";
import { renderMarkdown } from "@/render/markdown";

const props = defineProps<{ block: NormalizedBlock }>();
const expanded = ref(false);
const local = computed(() => ({
  command: String(props.block.meta?.command ?? "").trim(),
  stdout: String(props.block.meta?.stdout ?? "").trim(),
  stderr: String(props.block.meta?.stderr ?? "").trim(),
}));
const localOutput = computed(() => [local.value.stdout, local.value.stderr].filter(Boolean).join("\n"));
const taskState = computed(() => String(props.block.meta?.status ?? "").toLowerCase());
</script>

<template>
  <div
    v-if="block.kind === 'local-command'"
    class="cw-local-command"
    :class="{ 'cw-system-error': block.isError }"
  >
    <button
      v-if="localOutput"
      type="button"
      class="cw-local-command-summary"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >{{ local.command || "Local command" }} {{ expanded ? "▾" : "▸" }}</button>
    <span v-else class="cw-local-command-summary">{{ local.command || block.text || "Local command" }}</span>
    <pre v-if="expanded && localOutput" class="cw-local-command-output">{{ localOutput }}</pre>
  </div>
  <div
    v-else-if="block.kind === 'task-notification'"
    class="cw-task-notification"
    :class="{ 'cw-task-notification-failed': block.isError }"
  >
    <span aria-hidden="true">{{ block.isError ? "⚠" : "✓" }}</span>
    <span>{{ block.text || taskState || "Background task updated" }}</span>
  </div>
  <div v-else-if="block.kind === 'away-summary'" class="cw-away-summary">
    <strong>Recap</strong>
    <div class="prose" v-html="renderMarkdown(block.text || '')" />
  </div>
  <div v-else class="cw-system-block" :class="{ 'cw-system-error': block.isError }">
    {{ block.text || block.kind }}
  </div>
</template>
