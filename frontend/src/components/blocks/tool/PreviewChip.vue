<script setup lang="ts">
const props = defineProps<{ summary: string; path: string }>();

// Open the preview in a NEW browser tab instead of the in-app iframe
// overlay. `noopener` severs window.opener so the sandboxed preview page
// can't reach back into the app; the new tab loads /preview/<uuid>/...
// directly (carries the cw_token cookie, so the proxy lets it through).
function open() {
  window.open(window.location.origin + props.path, "_blank", "noopener");
}
</script>

<template>
  <button
    type="button"
    class="cw-preview-chip block w-full text-left px-4 py-2 border-l-4 transition-colors"
    :title="`Open preview · ${path}`"
    @click="open"
  >
    <span class="flex items-baseline gap-2 min-w-0">
      <span class="cw-preview-chip-label text-[11px] uppercase tracking-wide shrink-0">▦ Preview</span>
      <span class="text-sm text-[var(--cw-text)]  truncate min-w-0">{{ summary }}</span>
      <span class="ml-auto text-xs opacity-50 shrink-0">▸</span>
    </span>
  </button>
</template>
