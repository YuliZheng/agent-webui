<script setup lang="ts">
import { computed } from "vue";
import { flagEmojiAssetKey } from "../util/session-title-emoji.js";

const props = defineProps<{ emoji: string }>();

// Windows renders regional-indicator flag sequences as plain letters (for
// example 🇨🇭 becomes CH). Bundle only Twemoji's flag subset so flags remain
// recognizable in Edge without replacing the platform's ordinary emoji.
const flagAssets = import.meta.glob<string>(
  "../../../node_modules/@twemoji/svg/1f1*.svg",
  { eager: true, import: "default", query: "?url&no-inline" },
);
const flagUrls = new Map(
  Object.entries(flagAssets).flatMap(([path, url]) => {
    const filename = /\/([^/]+)\.svg$/u.exec(path)?.[1];
    return filename ? [[filename, url] as const] : [];
  }),
);

const flagUrl = computed(() => {
  const key = flagEmojiAssetKey(props.emoji);
  return key ? flagUrls.get(key) ?? null : null;
});
</script>

<template>
  <span
    aria-hidden="true"
    class="cw-emoji-glyph inline-flex shrink-0 items-center justify-center align-middle leading-none"
  >
    <img
      v-if="flagUrl"
      :src="flagUrl"
      alt=""
      draggable="false"
      class="block h-full w-full object-contain"
    />
    <span v-else class="cw-emoji-glyph-system block whitespace-nowrap">{{ emoji }}</span>
  </span>
</template>

<style scoped>
.cw-emoji-glyph-system {
  /* Keep system emoji in the same explicit square as flag assets. The flex
     wrapper owns centering; per-font horizontal nudges over-correct once the
     former inline text node has a real box. */
  font-family: "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif;
  line-height: 1;
}
</style>
