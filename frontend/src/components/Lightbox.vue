<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useLightboxStore } from "../stores/lightbox.js";
import { useUiStore } from "../stores/ui.js";
import { imageDownloadName } from "../lib/image-download.js";
import { APP_BACK_PRIORITY, registerAppBackHandler } from "../util/app-back.js";
import { setPwaLayerActive } from "../util/pwa-history.js";

const lightbox = useLightboxStore();
const ui = useUiStore();
const downloadName = computed(() => imageDownloadName(lightbox.alt, lightbox.url ?? ""));
const downloadStarted = ref(false);
let restoreThemeColor: (() => void) | null = null;
let downloadNoticeTimer: ReturnType<typeof setTimeout> | null = null;
let unregisterAppBack: (() => void) | undefined;

function clearDownloadNotice() {
  if (downloadNoticeTimer) clearTimeout(downloadNoticeTimer);
  downloadNoticeTimer = null;
  downloadStarted.value = false;
}

function onDownloadClick() {
  clearDownloadNotice();
  downloadStarted.value = true;
  downloadNoticeTimer = setTimeout(() => {
    downloadStarted.value = false;
    downloadNoticeTimer = null;
  }, 1_800);
}

function leaveImmersiveTheme() {
  restoreThemeColor?.();
  restoreThemeColor = null;
}

watch(() => lightbox.url, (url) => {
  setPwaLayerActive("lightbox", !!url, ui.selectedSessionId);
  leaveImmersiveTheme();
  clearDownloadNotice();
  if (!url) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const previous = meta.getAttribute("content");
  meta.setAttribute("content", "#000000");
  restoreThemeColor = () => {
    if (previous === null) meta.removeAttribute("content");
    else meta.setAttribute("content", previous);
  };
}, { immediate: true });

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && lightbox.url) lightbox.close();
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  unregisterAppBack = registerAppBackHandler(() => {
    if (!lightbox.url) return false;
    lightbox.close();
    return true;
  }, APP_BACK_PRIORITY.overlay);
});
onBeforeUnmount(() => {
  unregisterAppBack?.();
  window.removeEventListener("keydown", onKey);
  clearDownloadNotice();
  leaveImmersiveTheme();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="lightbox.url"
      class="cw-image-lightbox fixed inset-0 z-[100] flex min-h-[100dvh] w-full items-center justify-center overflow-hidden bg-black cursor-zoom-out"
      @click="lightbox.close()"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
    >
      <img
        :src="lightbox.url"
        :alt="lightbox.alt"
        class="block max-h-[100dvh] max-w-full object-contain select-none"
        draggable="false"
        @click.stop="lightbox.close()"
      />
      <button
        class="sr-only"
        @click="lightbox.close()"
        aria-label="Close"
        title="Close (Esc)"
      >✕</button>
      <div
        class="pointer-events-none absolute bottom-0 right-0 flex items-center gap-2 pr-4 pb-[calc(env(safe-area-inset-bottom)+16px)]"
      >
        <span
          v-if="downloadStarted"
          class="rounded-full bg-black/70 px-3 py-1.5 text-xs text-white/90 backdrop-blur-sm"
          role="status"
        >已开始下载</span>
        <a
          :href="lightbox.url"
          :download="downloadName"
          class="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/15 backdrop-blur-sm transition active:scale-95 active:bg-black/80"
          @click.stop="onDownloadClick"
          aria-label="保存原图"
          title="保存原图"
        >
          <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3v11" />
            <path d="m7.5 10 4.5 4.5 4.5-4.5" />
            <path d="M5 16v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
          </svg>
        </a>
      </div>
    </div>
  </Teleport>
</template>
