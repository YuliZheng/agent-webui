<script setup lang="ts">
import { computed, ref } from "vue";
import type { ToolPair } from "../../../parser/group.js";
import { toolSummary } from "../../../parser/tool-summaries.js";
import ToolCall from "./ToolCall.vue";

export interface ToolRunItem {
  pair: ToolPair;
  uuid: string;
}

const props = defineProps<{
  items: ToolRunItem[];
  expanded?: boolean;
  expandedItemIds?: ReadonlySet<string>;
}>();
const emit = defineEmits<{
  (event: "update:expanded", value: boolean): void;
  (event: "update:item-expanded", value: { uuid: string; expanded: boolean }): void;
}>();
const localOpen = ref(false);
const open = computed({
  get: () => props.expanded ?? localOpen.value,
  set: (value: boolean) => {
    localOpen.value = value;
    emit("update:expanded", value);
  },
});

const count = computed(() => props.items.length);
const toolName = computed(() => {
  const names = new Set(props.items.map((item) => item.pair.use.name));
  return names.size === 1 ? props.items[0]?.pair.use.name ?? "tool" : "tool";
});
const label = computed(() => `${count.value} ${toolName.value === "Bash" ? "Bash" : "tool"} calls`);
const firstSummary = computed(() => props.items[0] ? toolSummary(props.items[0].pair.use.name, props.items[0].pair.use.input) : "");
const lastSummary = computed(() => {
  const last = props.items[props.items.length - 1];
  return last ? toolSummary(last.pair.use.name, last.pair.use.input) : "";
});
const summary = computed(() => {
  if (!firstSummary.value) return "";
  if (!lastSummary.value || lastSummary.value === firstSummary.value) return firstSummary.value;
  return `${firstSummary.value} -> ${lastSummary.value}`;
});

function setItemExpanded(uuid: string, expanded: boolean) {
  emit("update:item-expanded", { uuid, expanded });
}
</script>

<template>
  <div class="cw-tool-run">
    <template v-if="!open">
      <span
        v-for="item in items"
        :key="item.uuid"
        class="cw-tool-run-anchor"
        :data-uuid="item.uuid || undefined"
        aria-hidden="true"
      />
    </template>
    <button
      type="button"
      class="cw-tool-run-header"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="cw-tool-run-caret">{{ open ? "▼" : "▶" }}</span>
      <span class="cw-tool-run-count">{{ label }}</span>
      <span class="cw-tool-run-summary">{{ summary }}</span>
    </button>
    <div v-if="open" class="cw-tool-run-items">
      <div
        v-for="item in items"
        :key="item.uuid"
        class="cw-tool-run-item"
        :data-uuid="item.uuid || undefined"
      >
        <ToolCall
          :pair="item.pair"
          :expanded="expandedItemIds ? expandedItemIds.has(item.uuid) : undefined"
          @update:expanded="setItemExpanded(item.uuid, $event)"
        />
      </div>
    </div>
  </div>
</template>
