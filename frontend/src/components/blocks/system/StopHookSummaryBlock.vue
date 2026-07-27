<script setup lang="ts">
import { computed, ref } from "vue";
const props = defineProps<{ node: { record: Record<string, unknown> } }>();
const r = computed(() => props.node.record as any);
const errored = computed(() => (r.value.hookErrors?.length ?? 0) > 0 || r.value.preventedContinuation === true);
const open = ref(false);
</script>
<template>
  <div class="px-4 py-1 text-xs bg-[var(--cw-panel-2)]" :class="errored ? 'text-[var(--cw-danger)]' : 'opacity-60'">
    <div class="cursor-pointer" @click="open = !open">ⓘ {{ (r.hookInfos?.length ?? 0) }} hooks ran {{ open ? "▾" : "▸" }}</div>
    <pre v-if="open" class="whitespace-pre-wrap mt-1">{{ JSON.stringify({ hookInfos: r.hookInfos, hookErrors: r.hookErrors, toolUseID: r.toolUseID }, null, 2) }}</pre>
  </div>
</template>
