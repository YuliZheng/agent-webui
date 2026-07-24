<script setup lang="ts">
import type { NormalizedBlock } from "@/types";
defineProps<{ block: NormalizedBlock }>();
</script>
<template><div class="cw-system-block" :class="{ 'cw-system-error': block.isError }">{{ block.text || block.kind }}</div></template>
