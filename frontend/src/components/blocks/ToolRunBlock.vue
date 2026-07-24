<script setup lang="ts">
import { computed, ref } from "vue";
import type { Interaction, NormalizedBlock } from "@/types";
import { isBashToolName, toolSummary } from "@/util/tool-summary";
import ToolBlock from "./ToolBlock.vue";

const props = withDefaults(defineProps<{ items: NormalizedBlock[]; interactions?: Interaction[] }>(), { interactions: () => [] });
const open = ref(false);
const count = computed(() => props.items.length);
const runName = computed(() => props.items.length > 0 && props.items.every((item) => isBashToolName(item.toolName)) ? "Bash" : "tool");
const label = computed(() => `${count.value} ${runName.value} calls`);
const firstSummary = computed(() => props.items[0] ? toolSummary(props.items[0].toolName, props.items[0].toolInput) : "");
const lastSummary = computed(() => {
  const last = props.items.at(-1);
  return last ? toolSummary(last.toolName, last.toolInput) : "";
});
const summary = computed(() => !lastSummary.value || lastSummary.value === firstSummary.value ? firstSummary.value : `${firstSummary.value} -> ${lastSummary.value}`);
const interactionsFor = (item: NormalizedBlock) => props.interactions.filter((interaction) => !!item.toolUseId && interaction.toolUseId === item.toolUseId);
</script>

<template>
  <div class="cw-tool-run">
    <template v-if="!open">
      <span v-for="item in items" :key="item.key" class="cw-tool-run-anchor" :data-uuid="item.uuid || item.toolUseId || undefined" aria-hidden="true" />
    </template>
    <button type="button" class="cw-tool-run-header" :aria-expanded="open" @click="open = !open">
      <span class="cw-tool-run-caret">{{ open ? "▼" : "▶" }}</span>
      <span class="cw-tool-run-count">{{ label }}</span>
      <span class="cw-tool-run-summary">{{ summary }}</span>
    </button>
    <div v-if="open" class="cw-tool-run-items">
      <div v-for="item in items" :key="item.key" class="cw-tool-run-item" :data-uuid="item.uuid || item.toolUseId || undefined">
        <ToolBlock :block="item" :interactions="interactionsFor(item)" embedded />
      </div>
    </div>
  </div>
</template>
