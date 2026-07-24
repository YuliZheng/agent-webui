<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { MessageDisplayStyle, NormalizedBlock } from "@/types";
import { renderMarkdown } from "@/render/markdown";
import { useUiStore } from "@/stores/ui";
import { useIdentityStore } from "@/stores/identity";

const props = withDefaults(defineProps<{
  block: NormalizedBlock;
  displayStyle?: MessageDisplayStyle;
  preview?: boolean;
  hideActions?: boolean;
}>(), {
  displayStyle: "claude-code",
  preview: false,
  hideActions: false
});
const emit = defineEmits<{ rewind: [block: NormalizedBlock]; fork: [block: NormalizedBlock] }>();
const ui = useUiStore();
const identity = useIdentityStore();
const avatarUrl = "/api/me/avatar?v=2";
const preview = computed(() => props.preview === true);
const compactImages = computed(() => props.displayStyle === "claude-code");
const text = computed(() => props.block.text ?? "");
const images = computed(() => props.block.images ?? []);
const pdfs = computed(() => {
  const value = props.block.meta?.pdfs;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
});
const html = computed(() => renderMarkdown(text.value));
const promptCollapsePx = computed(() => props.displayStyle === "claude-code" ? 54 : 180);
const promptBody = ref<HTMLDivElement | null>(null);
const collapsed = ref(true);
const canCollapse = ref(false);
const previewLikelyCollapsible = computed(() =>
  preview.value && (images.value.length > 0 || text.value.length > 90 || text.value.includes("\n"))
);
const collapsible = computed(() => canCollapse.value || previewLikelyCollapsible.value);
const bodyCollapsed = computed(() => preview.value ? collapsed.value : (collapsible.value && collapsed.value));
const wechatBubbleAvatar = computed(() =>
  props.displayStyle === "wechat" && (images.value.length > 0 || pdfs.value.length > 0) && text.value.length > 0
);
const imageDimensions = reactive<Record<string, string>>({});
let resizeObserver: ResizeObserver | null = null;

function measureCollapse() {
  const element = promptBody.value;
  if (!element) { canCollapse.value = false; return; }
  canCollapse.value = element.scrollHeight > promptCollapsePx.value + 8;
}
function toggleCollapsed(event: MouseEvent) {
  collapsed.value = !collapsed.value;
  if (event.detail > 0) (event.currentTarget as HTMLElement | null)?.blur();
}
function imageLoaded(url: string, event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  if (image.naturalWidth && image.naturalHeight) imageDimensions[url] = `${image.naturalWidth}×${image.naturalHeight}`;
}
function hideBrokenAvatar(event: Event) {
  const image = event.currentTarget as HTMLImageElement | null;
  if (image) image.style.display = "none";
}

const actionable = computed(() => !!props.block.uuid && !props.hideActions);
const menuOpen = ref(false);
const menuX = ref(0);
const menuY = ref(0);
const menuEl = ref<HTMLDivElement | null>(null);
const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 10;
const MENU_W = 168;
const MENU_H = 132;
let pressTimer: number | null = null;
let pressStart: { x: number; y: number } | null = null;

function clearPress() {
  if (pressTimer != null) { clearTimeout(pressTimer); pressTimer = null; }
  pressStart = null;
}
function onPressDown(event: PointerEvent) {
  if (!actionable.value || event.pointerType !== "touch" || preview.value) return;
  pressStart = { x: event.clientX, y: event.clientY };
  if (pressTimer != null) clearTimeout(pressTimer);
  pressTimer = window.setTimeout(() => {
    pressTimer = null;
    const start = pressStart;
    pressStart = null;
    if (start) openMenuAt(start.x, start.y);
  }, LONG_PRESS_MS);
}
function onPressMove(event: PointerEvent) {
  if (!pressStart) return;
  if (Math.abs(event.clientX - pressStart.x) > MOVE_CANCEL_PX ||
      Math.abs(event.clientY - pressStart.y) > MOVE_CANCEL_PX) clearPress();
}
function onContextMenu(event: MouseEvent) {
  if (!actionable.value || preview.value) return;
  event.preventDefault();
  clearPress();
  openMenuAt(event.clientX, event.clientY);
}
function openMenuAt(x: number, y: number) {
  menuX.value = Math.max(8, Math.min(x, window.innerWidth - MENU_W - 8));
  menuY.value = Math.max(8, Math.min(y, window.innerHeight - MENU_H - 8));
  menuOpen.value = true;
  try { navigator.vibrate?.(10); } catch { /* vibration is optional */ }
  void nextTick(() => {
    document.addEventListener("pointerdown", onDocPointerDown, true);
    window.addEventListener("scroll", closeMenu, true);
  });
}
function onDocPointerDown(event: PointerEvent) {
  if (menuEl.value && event.target instanceof Node && menuEl.value.contains(event.target)) return;
  closeMenu();
}
function closeMenu() {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  window.removeEventListener("scroll", closeMenu, true);
}
async function copyPrompt() {
  const value = text.value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  ui.toast("Prompt copied");
}
async function menuCopy() { closeMenu(); await copyPrompt(); }
function menuRewind() { closeMenu(); emit("rewind", props.block); }
function menuFork() { closeMenu(); emit("fork", props.block); }

onMounted(() => {
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(measureCollapse);
    if (promptBody.value) resizeObserver.observe(promptBody.value);
  }
  void nextTick(measureCollapse);
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  clearPress();
  closeMenu();
});
watch([text, () => images.value.length, promptCollapsePx], async () => {
  collapsed.value = true;
  await nextTick();
  measureCollapse();
});
</script>

<template>
  <div
    class="cw-block cw-user-prompt-wrap group"
    :class="{
      'cw-user-prompt-preview': preview,
      'cw-user-prompt-expanded': collapsible && !collapsed,
      'cw-user-prompt-is-collapsed': bodyCollapsed,
    }"
    data-user-prompt-visual="true"
    :data-visual-uuid="block.uuid || ''"
    @pointerdown="onPressDown"
    @pointermove="onPressMove"
    @pointerup="clearPress"
    @pointercancel="clearPress"
    @contextmenu="onContextMenu"
  >
    <div v-if="images.length || pdfs.length" class="cw-user-prompt-image-bubble cw-user-prompt">
      <div class="cw-user-prompt-images">
        <button
          v-for="image in images"
          :key="image"
          type="button"
          :class="compactImages ? 'cw-img-chip' : 'cw-chat-image'"
          title="Attached image"
          @click.stop="ui.lightboxUrl = image"
        >
          <span><img :src="image" alt="Attached image" loading="lazy" decoding="async" @load="imageLoaded(image, $event)" /></span>
          <span v-if="compactImages" class="cw-img-chip-name">image</span>
          <span v-if="compactImages && imageDimensions[image]" class="cw-img-chip-dims">{{ imageDimensions[image] }}</span>
        </button>
        <span v-for="pdf in pdfs" :key="pdf" class="cw-user-prompt-pdf-chip" :title="pdf">📄 <span>{{ pdf }}</span></span>
      </div>
    </div>
    <div v-if="text" class="cw-user-prompt-text-bubble cw-user-prompt">
      <span v-if="wechatBubbleAvatar" class="cw-bubble-avatar" aria-hidden="true">
        <span class="cw-message-avatar-fallback">{{ identity.initials }}</span>
        <img :src="avatarUrl" alt="" loading="lazy" decoding="async" @error="hideBrokenAvatar" />
      </span>
      <div ref="promptBody" class="cw-user-prompt-body" :class="bodyCollapsed ? 'cw-user-prompt-collapsed' : ''">
        <div class="prose" v-html="html" />
        <div v-if="!preview && collapsible && collapsed" class="cw-user-prompt-fade" />
      </div>
      <button v-if="collapsible" type="button" class="cw-user-prompt-toggle" @click="toggleCollapsed">
        {{ collapsed ? "Show more" : "Show less" }}
      </button>
    </div>
    <div v-if="!text && !images.length && !pdfs.length" class="cw-user-prompt" />
    <div v-if="actionable" class="cw-user-prompt-actions">
      <button class="cw-user-prompt-action" title="Copy prompt" :disabled="!text" @click="copyPrompt">Copy</button>
      <button class="cw-user-prompt-action" title="Rewind: discard this and everything after, prefill composer" @click="emit('rewind', block)">↺ Rewind</button>
      <button class="cw-user-prompt-action" title="Fork: create a new session branched from this point" @click="emit('fork', block)">⑂ Fork</button>
    </div>
  </div>
  <Teleport to="body">
    <div
      v-if="menuOpen"
      ref="menuEl"
      class="cw-prompt-action-menu"
      role="menu"
      :style="{ top: menuY + 'px', left: menuX + 'px' }"
      @pointerdown.stop
    >
      <button class="cw-prompt-action-menu-item" role="menuitem" :disabled="!text" @click="menuCopy">Copy</button>
      <button class="cw-prompt-action-menu-item" role="menuitem" @click="menuRewind">↺ Rewind</button>
      <button class="cw-prompt-action-menu-item" role="menuitem" @click="menuFork">⑂ Fork</button>
    </div>
  </Teleport>
</template>
