<script setup lang="ts">
import { ref, computed, onMounted } from "vue";

// Attached-image thumbnail with automatic recovery from mobile decode
// failures. Mobile browsers (esp. iOS Safari) silently fail to DECODE an
// image even after the bytes arrive 200 OK when cumulative decode memory
// hits the per-page ceiling — the <img> fires `error`, shows the broken
// icon, and never retries on its own. The user's only fix today is a full
// page refresh. This component:
//   - decoding="async" + loading="lazy" so off-screen images don't all
//     hold decoded pixels at once (caps peak decode memory)
//   - on `error`, retries up to MAX_RETRIES with backoff + a cache-busting
//     query param (forces a fresh decode attempt, not the poisoned cache
//     entry)
//   - after exhausting retries, shows a "tap to reload" tile instead of a
//     dead broken-icon, so recovery is one tap not a full refresh
// `compact` renders a small attachment chip (tiny thumbnail + filename +
// W×H), mirroring the real Claude Code prompt UI, instead of a large preview
// tile. Used for image attachments in claude-code user prompts.
const props = defineProps<{ src: string; alt: string; compact?: boolean }>();
const emit = defineEmits<{ (e: "open"): void }>();

const MAX_RETRIES = 3;
const retry = ref(0);
const failed = ref(false);
const loaded = ref(false);

// Tile loads a server-downscaled thumbnail (`?thumb=1`), NOT the full image.
// A session with many 2-4 MP screenshots otherwise blows the mobile decode
// memory ceiling and images silently fail to paint (refresh doesn't even
// recover them, because the other full-res images still hold the budget).
// The lightbox (open handler in the parent) still loads the full original.
const thumbSrc = computed(() =>
  props.src.startsWith("data:")
    ? props.src
    : `${props.src}${props.src.includes("?") ? "&" : "?"}thumb=1`,
);
// Cache-bust on retry only — first load uses the clean thumb URL so the normal
// HTTP cache still works. `&r=N` forces the browser to re-fetch + re-decode
// rather than reuse the failed-decode cache entry.
const effectiveSrc = computed(() =>
  retry.value === 0 || props.src.startsWith("data:")
    ? thumbSrc.value
    : `${thumbSrc.value}&r=${retry.value}`,
);

function onError() {
  if (retry.value < MAX_RETRIES) {
    // Backoff: 300ms, 600ms, 900ms. Gives the browser a moment to free
    // decode memory (e.g. as the user scrolls other images off-screen)
    // before the next attempt.
    const delay = 300 * (retry.value + 1);
    setTimeout(() => { retry.value += 1; }, delay);
  } else {
    failed.value = true;
  }
}

function onLoad() {
  loaded.value = true;
  failed.value = false;
}

function manualReload() {
  failed.value = false;
  loaded.value = false;
  retry.value += 1; // bumps effectiveSrc → fresh fetch
}

// Original pixel dimensions for the compact chip's "W×H" label. Read from the
// backend (`?meta=1` → ImageMagick identify) so we don't decode the full image
// client-side just to label it. Silently omitted if the fetch/route fails.
const dims = ref<{ w: number; h: number } | null>(null);
const dimsLabel = computed(() => (dims.value ? `${dims.value.w}×${dims.value.h}` : ""));
onMounted(async () => {
  if (!props.compact || props.src.startsWith("data:")) return;
  try {
    const url = `${props.src}${props.src.includes("?") ? "&" : "?"}meta=1`;
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) return;
    const j = await r.json();
    if (j && typeof j.width === "number" && typeof j.height === "number") {
      dims.value = { w: j.width, h: j.height };
    }
  } catch { /* chip just shows the filename */ }
});
</script>

<template>
  <!-- Compact chip (claude-code prompts): tiny thumbnail + filename + W×H,
       like the real Claude Code attachment row. Click still opens the
       lightbox. -->
  <button
    v-if="compact"
    type="button"
    class="cw-img-chip inline-flex items-center gap-2 max-w-[280px] rounded-md border border-[var(--cw-border)]  bg-[var(--cw-panel-2)]  hover:bg-[var(--cw-panel-2)]  pl-1 pr-2 py-1 transition cursor-zoom-in text-left"
    @click.stop="failed ? manualReload() : emit('open')"
    :title="alt"
  >
    <span class="shrink-0 w-7 h-7 rounded overflow-hidden bg-[var(--cw-panel-bg)] flex items-center justify-center">
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
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 opacity-60">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.5-3.5L9 20" />
      </svg>
    </span>
    <span class="min-w-0 text-xs font-semibold truncate text-[var(--cw-text)] ">{{ alt || "image" }}</span>
    <span v-if="dimsLabel" class="shrink-0 text-[11px] text-[var(--cw-text)]  tabular-nums">{{ dimsLabel }}</span>
  </button>
  <button
    v-else-if="failed"
    type="button"
    class="flex flex-col items-center justify-center gap-1 h-40 w-[12rem] rounded border border-dashed border-[var(--cw-border)]  bg-[var(--cw-panel-2)] text-xs opacity-70 hover:opacity-100 transition"
    @click.stop="manualReload"
    :title="alt"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-6 h-6">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
    <span>点击重载</span>
  </button>
  <button
    v-else
    type="button"
    class="flex h-40 w-[12rem] items-center justify-center rounded overflow-hidden border border-[color:color-mix(in_srgb,var(--cw-accent)_30%,transparent)] bg-[var(--cw-panel-bg)] hover:opacity-90 active:opacity-80 transition cursor-zoom-in"
    @click="emit('open')"
    :title="alt"
  >
    <img
      :src="effectiveSrc"
      :alt="alt"
      loading="lazy"
      decoding="async"
      class="block max-h-full max-w-full object-contain"
      @error="onError"
      @load="onLoad"
    />
  </button>
</template>
