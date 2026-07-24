<script setup lang="ts">
import { computed, ref } from "vue";

const props = withDefaults(defineProps<{
  src: string;
  alt?: string;
  compact?: boolean;
}>(), {
  alt: "image",
  compact: false
});
const emit = defineEmits<{ open: [] }>();
const failed = ref(false);
const reloadKey = ref(0);
const width = ref(0);
const height = ref(0);
const thumbnailSrc = computed(() => {
  if (!props.compact || props.src.startsWith("data:") || props.src.startsWith("blob:")) return props.src;
  const separator = props.src.includes("?") ? "&" : "?";
  return `${props.src}${separator}thumb=1`;
});
const effectiveSrc = computed(() => {
  const base = thumbnailSrc.value;
  if (!reloadKey.value || base.startsWith("data:")) return base;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}reload=${reloadKey.value}`;
});
const dimsLabel = computed(() => width.value && height.value ? `${width.value}×${height.value}` : "");

function onLoad(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  failed.value = false;
  width.value = image.naturalWidth;
  height.value = image.naturalHeight;
}

function onError() {
  failed.value = true;
}

function manualReload() {
  failed.value = false;
  reloadKey.value = Date.now();
}
</script>

<template>
  <button
    v-if="compact"
    type="button"
    class="cw-img-chip inline-flex items-center gap-2 max-w-[280px] rounded-md border border-gray-200/70 dark:border-gray-700/50 bg-gray-50/70 dark:bg-gray-800/50 hover:bg-gray-100/70 dark:hover:bg-gray-800/60 pl-1 pr-2 py-1 transition cursor-zoom-in text-left"
    :title="alt"
    @click.stop="failed ? manualReload() : emit('open')"
  >
    <span class="shrink-0 w-7 h-7 rounded overflow-hidden bg-white dark:bg-gray-900 flex items-center justify-center">
      <img
        v-if="!failed"
        :src="effectiveSrc"
        :alt="alt"
        loading="lazy"
        decoding="async"
        class="w-full h-full object-cover"
        @error="onError"
        @load="onLoad"
      />
      <span v-else aria-hidden="true">↻</span>
    </span>
    <span class="min-w-0 text-xs font-semibold truncate text-gray-700 dark:text-gray-200">{{ alt || "image" }}</span>
    <span v-if="dimsLabel" class="shrink-0 text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">{{ dimsLabel }}</span>
  </button>
  <button
    v-else
    type="button"
    class="cw-chat-image block rounded overflow-hidden border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:opacity-90 active:opacity-80 transition cursor-zoom-in"
    :title="alt"
    @click.stop="failed ? manualReload() : emit('open')"
  >
    <img
      v-if="!failed"
      :src="effectiveSrc"
      :alt="alt"
      loading="lazy"
      decoding="async"
      class="block max-h-[240px] object-contain"
      @error="onError"
      @load="onLoad"
    />
    <span v-else class="inline-flex min-h-20 min-w-28 items-center justify-center text-xs opacity-60">Image failed · retry</span>
  </button>
</template>
