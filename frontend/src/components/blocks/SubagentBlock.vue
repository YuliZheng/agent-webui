<script setup lang="ts">
import { ref } from "vue";
import type { TimelineNode } from "../../parser/group.js";

const props = defineProps<{ timeline: TimelineNode[] }>();
const open = ref(true);
</script>

<template>
  <div class="border-l-2 border-[var(--cw-border)]  pl-3 my-2 text-xs">
    <div class="opacity-60 cursor-pointer" @click="open = !open">
      ▸ subagent ({{ timeline.length }} events) {{ open ? "▾" : "▸" }}
    </div>
    <div v-if="open" class="space-y-2 mt-1">
      <pre v-for="(n, i) in timeline" :key="i" class="whitespace-pre-wrap text-[10px] opacity-80 bg-[var(--cw-panel-2)] p-1 rounded">{{ JSON.stringify(n.record, null, 2).slice(0, 400) }}</pre>
    </div>
  </div>
</template>
