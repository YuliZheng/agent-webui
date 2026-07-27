<script setup lang="ts">
import { computed, ref } from "vue";
const props = defineProps<{ node: { record: Record<string, unknown> } }>();
const r = computed(() => props.node.record as any);
const open = ref(false);
const msg = computed(() => r.value.error?.error?.message ?? "");
</script>
<template>
  <div class="px-4 py-2 border-l-4 border-[var(--cw-danger)] bg-[color-mix(in_srgb,var(--cw-danger)_10%,transparent)] text-xs">
    <div class="text-[var(--cw-danger)]">API error: {{ msg }}</div>
    <div class="opacity-70 mt-1">retry {{ r.retryAttempt ?? 0 }}/{{ r.maxRetries ?? 0 }} in {{ r.retryInMs ?? 0 }}ms</div>
    <div class="cursor-pointer underline mt-1" @click="open = !open">{{ open ? "hide" : "show" }} payload</div>
    <pre v-if="open" class="whitespace-pre-wrap mt-1">{{ JSON.stringify(r.error, null, 2) }}</pre>
  </div>
</template>
