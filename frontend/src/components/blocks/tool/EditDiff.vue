<script setup lang="ts">
const props = defineProps<{ input: { file_path?: string; old_string?: string; new_string?: string; replace_all?: boolean } }>();
</script>

<template>
  <div class="text-xs">
    <div class="opacity-60 mb-1">{{ props.input.file_path }} <span v-if="props.input.replace_all">[replace_all]</span></div>
    <pre class="bg-[color-mix(in_srgb,var(--cw-danger)_12%,transparent)] p-2 whitespace-pre-wrap">- {{ props.input.old_string }}</pre>
    <pre class="bg-[color-mix(in_srgb,var(--cw-success)_12%,transparent)] p-2 whitespace-pre-wrap">+ {{ props.input.new_string }}</pre>
  </div>
</template>
