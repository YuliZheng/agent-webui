<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ node: { record: Record<string, unknown> } }>();

const result = computed(() => {
  const m = (props.node.record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(m)) return null;
  const tr = m.find((b: any) => b?.type === "tool_result") as any;
  return tr ?? null;
});
</script>

<template>
  <div v-if="result" class="px-4 py-1 text-xs opacity-50 italic">
    Tool result for <span class="font-mono">{{ result.tool_use_id }}</span> (orphaned)
  </div>
</template>
