<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue";
import { useLightboxStore } from "../stores/lightbox.js";

const lightbox = useLightboxStore();

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && lightbox.url) lightbox.close();
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="lightbox.url"
      class="fixed inset-0 z-50 bg-black/90 flex items-center justify-center cursor-zoom-out p-4"
      @click="lightbox.close()"
    >
      <img
        :src="lightbox.url"
        :alt="lightbox.alt"
        class="max-w-full max-h-full object-contain select-none"
        draggable="false"
        @click.stop
      />
      <button
        class="absolute top-4 right-4 w-10 h-10 rounded-full bg-black/50 text-white text-xl flex items-center justify-center hover:bg-black/70"
        @click="lightbox.close()"
        aria-label="Close"
        title="Close (Esc)"
      >✕</button>
    </div>
  </Teleport>
</template>
