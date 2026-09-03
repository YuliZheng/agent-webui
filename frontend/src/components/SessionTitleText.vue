<script setup lang="ts">
import { computed } from "vue";
import EmojiGlyph from "./EmojiGlyph.vue";
import { sessionTitleEmojiForDisplay } from "../util/session-title-emoji.js";

const props = defineProps<{
  title: string;
  emoji?: string | null | undefined;
  source?: "auto" | "manual" | null | undefined;
}>();

const displayEmoji = computed(() => sessionTitleEmojiForDisplay(
  props.title,
  props.emoji,
  props.source,
));
</script>

<template>
  <span class="inline-flex min-w-0 max-w-full items-center gap-[0.32em] align-middle">
    <span class="min-w-0 truncate">{{ title }}</span>
    <EmojiGlyph
      v-if="displayEmoji"
      :emoji="displayEmoji"
      class="h-[1.05em] w-[1.05em] shrink-0"
    />
  </span>
</template>
