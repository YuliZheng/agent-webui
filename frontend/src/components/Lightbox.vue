<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useLightboxStore } from "../stores/lightbox.js";
import { useUiStore } from "../stores/ui.js";
import { imageDownloadName } from "../lib/image-download.js";
import { APP_BACK_PRIORITY, registerAppBackHandler } from "../util/app-back.js";
import { setPwaLayerActive } from "../util/pwa-history.js";
import {
  gallerySwipeDirection,
  resistGallerySwipe,
  type GallerySwipeDirection,
} from "../util/image-gallery.js";
import {
  DOUBLE_TAP_IMAGE_SCALE,
  MAX_IMAGE_SCALE,
  MIN_IMAGE_SCALE,
  clampImageScale,
  clampImageTransform,
  imagePanBounds,
  resistImageOffset,
  zoomImageAtPoint,
  type ImageTransform,
} from "../util/image-viewport.js";

const lightbox = useLightboxStore();
const ui = useUiStore();
const downloadName = computed(() => imageDownloadName(lightbox.alt, lightbox.url ?? ""));
const downloadStarted = ref(false);
const viewport = ref<HTMLElement | null>(null);
const image = ref<HTMLImageElement | null>(null);
const imageTransform = ref<ImageTransform>({ scale: 1, x: 0, y: 0 });
const transitioning = ref(false);
const dragging = ref(false);
const gallerySwitching = ref(false);
const galleryCount = computed(() => lightbox.items.length);
const galleryPosition = computed(() => lightbox.index + 1);
const canPrevious = computed(() => lightbox.index > 0);
const canNext = computed(() => lightbox.index >= 0 && lightbox.index < galleryCount.value - 1);
let restoreThemeColor: (() => void) | null = null;
let downloadNoticeTimer: ReturnType<typeof setTimeout> | null = null;
let transitionTimer: ReturnType<typeof setTimeout> | null = null;
let gallerySwitchTimer: ReturnType<typeof setTimeout> | null = null;
let singleTapTimer: ReturnType<typeof setTimeout> | null = null;
let unregisterAppBack: (() => void) | undefined;

interface Point { x: number; y: number }
interface PinchSnapshot {
  distance: number;
  center: Point;
  transform: ImageTransform;
}

const pointers = new Map<number, Point>();
let pinchSnapshot: PinchSnapshot | null = null;
let panPointerId: number | null = null;
let panStart: Point = { x: 0, y: 0 };
let panTransform: ImageTransform = { scale: 1, x: 0, y: 0 };
let gestureStart: Point = { x: 0, y: 0 };
let gestureStartedAt = 0;
let gestureMoved = false;
let gestureUsedMultiplePointers = false;
let gestureStartedOnImage = false;
let gestureStartedScale = MIN_IMAGE_SCALE;
let lastTapAt = 0;
let lastTapPoint: Point = { x: 0, y: 0 };

const transformStyle = computed(() => ({
  transform: `translate3d(${imageTransform.value.x}px, ${imageTransform.value.y}px, 0) scale(${imageTransform.value.scale})`,
}));

const viewportCursor = computed(() => {
  if (dragging.value) return "cursor-grabbing";
  if (imageTransform.value.scale > MIN_IMAGE_SCALE) return "cursor-grab";
  return "cursor-zoom-in";
});

function clearTransitionTimer() {
  if (transitionTimer) clearTimeout(transitionTimer);
  transitionTimer = null;
}

function clearSingleTapTimer() {
  if (singleTapTimer) clearTimeout(singleTapTimer);
  singleTapTimer = null;
}

function clearGallerySwitchTimer() {
  if (gallerySwitchTimer) clearTimeout(gallerySwitchTimer);
  gallerySwitchTimer = null;
}

function viewportBounds() {
  return {
    imageWidth: image.value?.clientWidth ?? 0,
    imageHeight: image.value?.clientHeight ?? 0,
    viewportWidth: viewport.value?.clientWidth ?? window.innerWidth,
    viewportHeight: viewport.value?.clientHeight ?? window.innerHeight,
  };
}

function animateTransform(next: ImageTransform) {
  clearTransitionTimer();
  transitioning.value = true;
  imageTransform.value = next;
  transitionTimer = setTimeout(() => {
    transitioning.value = false;
    transitionTimer = null;
  }, 220);
}

function resetTransform(animated = false) {
  const reset = { scale: 1, x: 0, y: 0 };
  if (animated) animateTransform(reset);
  else {
    clearTransitionTimer();
    transitioning.value = false;
    imageTransform.value = reset;
  }
  pointers.clear();
  pinchSnapshot = null;
  panPointerId = null;
  dragging.value = false;
}

function switchGallery(direction: GallerySwipeDirection): boolean {
  const canMove = direction === "next" ? canNext.value : canPrevious.value;
  if (!canMove || gallerySwitching.value) return false;
  clearSingleTapTimer();
  clearGallerySwitchTimer();
  gallerySwitching.value = true;
  const viewportWidth = viewport.value?.clientWidth ?? window.innerWidth;
  animateTransform({
    scale: MIN_IMAGE_SCALE,
    x: direction === "next" ? -viewportWidth : viewportWidth,
    y: 0,
  });
  gallerySwitchTimer = setTimeout(() => {
    gallerySwitchTimer = null;
    const moved = direction === "next" ? lightbox.next() : lightbox.previous();
    gallerySwitching.value = false;
    if (!moved) resetTransform(true);
  }, 150);
  return true;
}

function settleTransform() {
  animateTransform(clampImageTransform(imageTransform.value, viewportBounds()));
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointerCenter(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function relativeToViewport(point: Point): Point {
  const rect = viewport.value?.getBoundingClientRect();
  if (!rect) return point;
  return {
    x: point.x - rect.left - rect.width / 2,
    y: point.y - rect.top - rect.height / 2,
  };
}

function beginPinch() {
  const [first, second] = [...pointers.values()];
  if (!first || !second) return;
  pinchSnapshot = {
    distance: Math.max(1, distance(first, second)),
    center: pointerCenter(first, second),
    transform: { ...imageTransform.value },
  };
}

function beginPan(pointerId: number, point: Point) {
  panPointerId = pointerId;
  panStart = point;
  panTransform = { ...imageTransform.value };
}

function elasticScale(rawScale: number): number {
  if (rawScale < MIN_IMAGE_SCALE) {
    return Math.max(0.84, MIN_IMAGE_SCALE - (MIN_IMAGE_SCALE - rawScale) * 0.24);
  }
  if (rawScale > MAX_IMAGE_SCALE) {
    return Math.min(5.6, MAX_IMAGE_SCALE + (rawScale - MAX_IMAGE_SCALE) * 0.2);
  }
  return rawScale;
}

function zoomAt(point: Point, targetScale: number) {
  const nextScale = clampImageScale(targetScale);
  const relativePoint = relativeToViewport(point);
  const zoomed = zoomImageAtPoint(imageTransform.value, nextScale, relativePoint);
  animateTransform(clampImageTransform(zoomed, viewportBounds()));
}

function handleTap(point: Point, startedOnImage: boolean) {
  if (!startedOnImage) {
    clearSingleTapTimer();
    lightbox.close();
    return;
  }
  const now = performance.now();
  if (now - lastTapAt <= 290 && distance(point, lastTapPoint) <= 36) {
    clearSingleTapTimer();
    lastTapAt = 0;
    if (imageTransform.value.scale > MIN_IMAGE_SCALE + 0.01) resetTransform(true);
    else zoomAt(point, DOUBLE_TAP_IMAGE_SCALE);
    return;
  }
  lastTapAt = now;
  lastTapPoint = point;
  clearSingleTapTimer();
  singleTapTimer = setTimeout(() => {
    singleTapTimer = null;
    lastTapAt = 0;
    lightbox.close();
  }, 300);
}

function onPointerDown(event: PointerEvent) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (gallerySwitching.value) return;
  clearTransitionTimer();
  transitioning.value = false;
  viewport.value?.setPointerCapture?.(event.pointerId);
  const point = { x: event.clientX, y: event.clientY };
  pointers.set(event.pointerId, point);
  if (pointers.size === 1) {
    gestureStart = point;
    gestureStartedAt = performance.now();
    gestureMoved = false;
    gestureUsedMultiplePointers = false;
    gestureStartedOnImage = event.target === image.value;
    gestureStartedScale = imageTransform.value.scale;
    beginPan(event.pointerId, point);
  } else {
    gestureUsedMultiplePointers = true;
    dragging.value = true;
    beginPinch();
  }
}

function onPointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return;
  const point = { x: event.clientX, y: event.clientY };
  pointers.set(event.pointerId, point);
  if (distance(point, gestureStart) > 7) gestureMoved = true;

  if (pointers.size >= 2 && pinchSnapshot) {
    event.preventDefault();
    const [first, second] = [...pointers.values()];
    if (!first || !second) return;
    const center = pointerCenter(first, second);
    const nextScale = elasticScale(
      pinchSnapshot.transform.scale * distance(first, second) / pinchSnapshot.distance,
    );
    const startCenter = relativeToViewport(pinchSnapshot.center);
    const currentCenter = relativeToViewport(center);
    const ratio = nextScale / pinchSnapshot.transform.scale;
    imageTransform.value = {
      scale: nextScale,
      x: currentCenter.x - (startCenter.x - pinchSnapshot.transform.x) * ratio,
      y: currentCenter.y - (startCenter.y - pinchSnapshot.transform.y) * ratio,
    };
    return;
  }

  if (pointers.size === 1 && panPointerId === event.pointerId && imageTransform.value.scale > 1) {
    event.preventDefault();
    dragging.value = true;
    const bounds = imagePanBounds(imageTransform.value.scale, viewportBounds());
    imageTransform.value = {
      ...imageTransform.value,
      x: resistImageOffset(panTransform.x + point.x - panStart.x, bounds.x),
      y: resistImageOffset(panTransform.y + point.y - panStart.y, bounds.y),
    };
    return;
  }

  if (
    pointers.size === 1
    && panPointerId === event.pointerId
    && gestureStartedScale <= 1.01
    && galleryCount.value > 1
  ) {
    const dx = point.x - gestureStart.x;
    const dy = point.y - gestureStart.y;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 4) {
      event.preventDefault();
      dragging.value = true;
      imageTransform.value = {
        scale: MIN_IMAGE_SCALE,
        x: resistGallerySwipe(dx, canPrevious.value, canNext.value),
        y: 0,
      };
    }
  }
}

function onPointerEnd(event: PointerEvent, cancelled = false) {
  if (!pointers.has(event.pointerId)) return;
  const releasedPoint = { x: event.clientX, y: event.clientY };
  pointers.delete(event.pointerId);

  if (pointers.size >= 2) {
    beginPinch();
    return;
  }
  pinchSnapshot = null;
  if (pointers.size === 1) {
    const remaining = pointers.entries().next().value as [number, Point] | undefined;
    if (remaining) beginPan(remaining[0], remaining[1]);
    return;
  }

  panPointerId = null;
  dragging.value = false;
  const dx = releasedPoint.x - gestureStart.x;
  const dy = releasedPoint.y - gestureStart.y;
  const swipe = gallerySwipeDirection({
    dx,
    dy,
    durationMs: performance.now() - gestureStartedAt,
    scale: gestureStartedScale,
    cancelled,
    multiplePointers: gestureUsedMultiplePointers,
  });
  const switched = swipe ? switchGallery(swipe) : false;
  if (!switched) settleTransform();
  const wasTap = !cancelled
    && !switched
    && !gestureUsedMultiplePointers
    && !gestureMoved
    && performance.now() - gestureStartedAt < 420;
  if (wasTap) handleTap(releasedPoint, gestureStartedOnImage);
  gestureUsedMultiplePointers = false;
}

function onWheel(event: WheelEvent) {
  const factor = Math.exp(-event.deltaY * 0.002);
  zoomAt({ x: event.clientX, y: event.clientY }, imageTransform.value.scale * factor);
}

function onImageLoad() {
  resetTransform(false);
}

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
  clearSingleTapTimer();
  resetTransform(false);
  if (!url) {
    clearGallerySwitchTimer();
    gallerySwitching.value = false;
    return;
  }
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
  if (!lightbox.url) return;
  if (e.key === "Escape") {
    lightbox.close();
    return;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    switchGallery("previous");
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    switchGallery("next");
  }
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", settleTransform);
  unregisterAppBack = registerAppBackHandler(() => {
    if (!lightbox.url) return false;
    lightbox.close();
    return true;
  }, APP_BACK_PRIORITY.overlay);
});
onBeforeUnmount(() => {
  unregisterAppBack?.();
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", settleTransform);
  clearDownloadNotice();
  clearSingleTapTimer();
  clearTransitionTimer();
  clearGallerySwitchTimer();
  leaveImmersiveTheme();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="lightbox.url"
      ref="viewport"
      class="cw-image-lightbox fixed inset-0 z-[100] flex min-h-[100dvh] w-full touch-none items-center justify-center overflow-hidden bg-black select-none"
      :class="viewportCursor"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerEnd"
      @pointercancel="onPointerEnd($event, true)"
      @wheel.prevent="onWheel"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      aria-describedby="cw-lightbox-help"
    >
      <img
        :key="lightbox.url"
        ref="image"
        :src="lightbox.url"
        :alt="lightbox.alt"
        class="block max-h-[100dvh] max-w-full object-contain will-change-transform"
        :class="transitioning ? 'transition-transform duration-200 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)]' : ''"
        :style="transformStyle"
        draggable="false"
        @load="onImageLoad"
      />
      <p id="cw-lightbox-help" class="sr-only">左右滑动切换图片，双指缩放，放大后拖动，双击放大或还原，单击关闭</p>
      <div
        v-if="galleryCount > 1"
        class="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 pt-[calc(env(safe-area-inset-top)+14px)] text-xs font-medium tabular-nums text-white/70"
        aria-live="polite"
        aria-atomic="true"
      >{{ galleryPosition }} / {{ galleryCount }}</div>
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
          @pointerdown.stop
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
