<script setup lang="ts">
import type { NormalizedBlock } from "@/types";
import UserPromptBlock from "./blocks/UserPromptBlock.vue";
defineProps<{ block: NormalizedBlock | null; translateY?: number }>();
</script>
<template>
  <div class="cw-sticky-prompt-overlay-frame" aria-hidden="true">
    <div v-if="block" class="cw-sticky-prompt-overlay" :style="{ transform: `translateY(${translateY || 0}px)` }">
      <UserPromptBlock :key="block.key" :block="block" preview hide-actions />
    </div>
  </div>
</template>
