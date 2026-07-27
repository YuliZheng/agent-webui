<script setup lang="ts">
import { computed } from "vue";
import { fmtDuration } from "../../../util/time.js";

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const props = defineProps<{
  node: { record: Record<string, unknown> };
  usage?: Usage | null;
}>();

const ms = computed(() => Number((props.node.record as any).durationMs ?? 0));

// Context window utilization = sum of all tokens the model was fed in this turn.
const ctxTokens = computed(() => {
  const u = props.usage;
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
});

const outTokens = computed(() => Number(props.usage?.output_tokens ?? 0));

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
</script>
<template>
  <div class="cw-turn-duration px-4 py-1 text-xs opacity-50">
    ⓘ Turn took {{ fmtDuration(ms) }}<template v-if="ctxTokens"> · ctx {{ fmtTokens(ctxTokens) }}</template><template v-if="outTokens"> · out {{ fmtTokens(outTokens) }}</template>
  </div>
</template>
