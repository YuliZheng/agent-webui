<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { usePreviewModalStore } from "../stores/preview-modal.js";
import { useUiStore } from "../stores/ui.js";
import { APP_BACK_PRIORITY, registerAppBackHandler } from "../util/app-back.js";
import { setPwaLayerActive } from "../util/pwa-history.js";

// Iframe-only overlay. The preview's title bar lives in MainPane's <header>
// (swapped in when active) so there's a single bar that aligns with the
// sidebar. This component just covers the message-list area with the iframe.
// "Active" = open AND owned by the currently-selected session, so switching
// away hides the iframe without dropping its state.

const modal = usePreviewModalStore();
const ui = useUiStore();
const stale = ref(false);
const checking = ref(false);
let unregisterAppBack: (() => void) | undefined;

const active = computed(() => modal.open && modal.sessionId === ui.selectedSessionId);
const iframeSrc = computed(() => (active.value ? window.location.origin + modal.path : ""));

async function checkStale() {
  if (!active.value) return;
  stale.value = false;
  checking.value = true;
  try {
    // Default credentials mode ("same-origin") sends the cw_token cookie so a
    // reverse proxy gating everything by cookie sees the request as authed —
    // the backend itself doesn't require auth on /preview but the proxy does.
    const r = await fetch(modal.path, { method: "HEAD" });
    // Treat only 404 as stale. Anything else (incl. transient proxy errors)
    // should fall through to the iframe, which will render either the file
    // or its own error.
    stale.value = r.status === 404;
  } catch {
    // Network/CORS failure: don't block on it. Let the iframe attempt to load.
    stale.value = false;
  } finally {
    checking.value = false;
  }
}

watch(active, (v) => {
  setPwaLayerActive("preview-overlay", v, ui.selectedSessionId);
  if (v) checkStale();
});

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && active.value) {
    e.preventDefault();
    modal.close();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  unregisterAppBack = registerAppBackHandler(() => {
    if (!active.value) return false;
    modal.close();
    return true;
  }, APP_BACK_PRIORITY.surface);
});
onUnmounted(() => {
  unregisterAppBack?.();
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div
    v-if="active"
    class="absolute inset-0 z-30 bg-[var(--cw-panel-bg)]"
  >
    <div
      v-if="stale"
      class="absolute inset-0 flex items-center justify-center text-[var(--cw-danger)]"
    >
      Preview not found.
    </div>
    <iframe
      v-else-if="iframeSrc"
      :src="iframeSrc"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      allow=""
      loading="lazy"
      class="w-full h-full border-0 bg-[var(--cw-panel-bg)]"
    />
  </div>
</template>
