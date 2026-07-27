<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import type { SkillEntry } from "@claude-webui/shared/api";

const props = defineProps<{ items: SkillEntry[]; activeIndex: number }>();
const emit = defineEmits<{ (e: "select", index: number): void; (e: "hover", index: number): void }>();

// Keep the keyboard-selected option scrolled into view. The menu is a fixed
// max-height scroll container; arrow-key nav only changes activeIndex (the
// highlight class), so without this the selection walks off the bottom and
// becomes invisible. `block: "nearest"` scrolls the minimum needed and is a
// no-op when the option is already visible.
const listEl = ref<HTMLElement | null>(null);
watch(
  () => props.activeIndex,
  async (i) => {
    await nextTick();
    const el = listEl.value?.children[i] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  },
);
</script>

<template>
  <div
    v-if="items.length > 0"
    ref="listEl"
    class="cw-slash-menu mb-2 max-h-64 overflow-y-auto rounded-lg border shadow-lg text-sm"
    role="listbox"
  >
    <button
      v-for="(item, i) in items"
      :key="item.name"
      type="button"
      role="option"
      :aria-selected="i === activeIndex"
      class="cw-slash-item w-full text-left px-3 py-1.5 flex flex-col gap-0.5"
      :class="{ 'cw-slash-item-active': i === activeIndex }"
      @mousedown.prevent="emit('select', i)"
      @mouseenter="emit('hover', i)"
    >
      <span class="cw-slash-name font-medium">/{{ item.name }}</span>
      <span
        v-if="item.description"
        class="cw-slash-description text-xs truncate"
      >{{ item.description }}</span>
    </button>
  </div>
</template>

<style scoped>
.cw-slash-menu {
  border-color: var(--cw-popover-border, var(--cw-border));
  background: var(--cw-popover-bg, var(--cw-panel-bg));
  color: var(--cw-popover-fg, var(--cw-text));
  box-shadow:
    0 14px 34px color-mix(in srgb, #000 22%, transparent),
    0 0 0 1px color-mix(in srgb, var(--cw-border) 34%, transparent);
}

.cw-slash-item {
  color: var(--cw-popover-fg, var(--cw-text));
}

.cw-slash-item:hover {
  background: var(--cw-popover-hover-bg, var(--cw-panel-2));
}

.cw-slash-item-active,
.cw-slash-item-active:hover {
  background: color-mix(
    in srgb,
    var(--cw-accent) 16%,
    var(--cw-popover-bg, var(--cw-panel-bg))
  );
}

.cw-slash-name {
  color: var(--cw-popover-fg, var(--cw-text));
}

.cw-slash-description {
  color: var(--cw-muted);
}
</style>
