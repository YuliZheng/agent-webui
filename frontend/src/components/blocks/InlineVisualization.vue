<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ sessionId: string; file: string }>();

const src = computed(() =>
  `/api/sessions/${encodeURIComponent(props.sessionId)}/visualization/${encodeURIComponent(props.file)}`,
);

function open() {
  window.open(window.location.origin + src.value, "_blank", "noopener");
}
</script>

<template>
  <section class="mx-4 my-2 overflow-hidden rounded-lg border border-[var(--cw-border)] bg-[var(--cw-panel-bg)]">
    <header class="flex items-center gap-2 border-b border-[var(--cw-border)] px-3 py-2 text-xs">
      <span class="font-semibold">▦ Interactive visualization</span>
      <span class="min-w-0 flex-1 truncate opacity-60">{{ file }}</span>
      <button type="button" class="shrink-0 underline underline-offset-2 opacity-75 hover:opacity-100" @click="open">
        Open
      </button>
    </header>
    <iframe
      :src="src"
      :title="file"
      sandbox="allow-scripts"
      loading="lazy"
      class="block h-[420px] w-full border-0 bg-white"
    />
  </section>
</template>
