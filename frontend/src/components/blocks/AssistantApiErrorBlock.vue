<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ node: { record: Record<string, unknown> } }>();
const err = computed(() => {
  const r = props.node.record as { apiErrorStatus?: number; error?: { error?: { message?: string } } };
  return {
    status: r.apiErrorStatus ?? "unknown",
    msg: r.error?.error?.message ?? JSON.stringify(r.error ?? {}, null, 2),
  };
});
</script>

<template>
  <div class="px-4 py-2 border-l-4 border-[var(--cw-danger)] bg-[color-mix(in_srgb,var(--cw-danger)_10%,transparent)]">
    <div class="text-xs uppercase tracking-wider mb-1 text-[var(--cw-danger)]">API error {{ err.status }}</div>
    <pre class="whitespace-pre-wrap text-xs">{{ err.msg }}</pre>
  </div>
</template>
