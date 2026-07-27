<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { deleteUserAvatar, putUserAvatar } from "../api/avatar.js";
import { useUiStore } from "../stores/ui.js";
import { useUserAvatarStore } from "../stores/user-avatar.js";
import { APP_BACK_PRIORITY, registerAppBackHandler } from "../util/app-back.js";
import { setPwaLayerActive } from "../util/pwa-history.js";
import { userInitials } from "../util/user-initials.js";

const AVATAR_SIZE = 320;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const ui = useUiStore();
const avatar = useUserAvatarStore();
const input = ref<HTMLInputElement | null>(null);
const candidate = ref<string | null>(null);
const fileName = ref("");
const busy = ref(false);
const dragging = ref(false);
const error = ref("");
const previewSrc = computed(() => candidate.value ?? avatar.src);
let unregisterAppBack: (() => void) | undefined;

watch(() => avatar.editorOpen, open => {
  setPwaLayerActive("avatar-editor", open, ui.selectedSessionId);
});

function close() {
  if (!busy.value) {
    candidate.value = null;
    fileName.value = "";
    error.value = "";
    avatar.closeEditor();
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("这张图片无法读取，请换一张试试"));
    image.src = url;
  });
}

function canvasDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error("图片处理失败"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("图片处理失败"));
      reader.readAsDataURL(blob);
    }, "image/png");
  });
}

async function prepare(file: File) {
  error.value = "";
  if (!ACCEPTED_TYPES.has(file.type)) {
    error.value = "请选择 PNG、JPG、WebP 或 GIF 图片";
    return;
  }
  if (!file.size || file.size > MAX_SOURCE_BYTES) {
    error.value = "原图不能超过 12 MB";
    return;
  }
  busy.value = true;
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (!side) throw new Error("这张图片没有有效尺寸");
    const sourceX = Math.round((image.naturalWidth - side) / 2);
    const sourceY = Math.round((image.naturalHeight - side) / 2);
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法处理这张图片");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, sourceX, sourceY, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    candidate.value = await canvasDataUrl(canvas);
    fileName.value = file.name;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "图片处理失败";
  } finally {
    URL.revokeObjectURL(objectUrl);
    busy.value = false;
  }
}

function picked(event: Event) {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (file) void prepare(file);
  (event.currentTarget as HTMLInputElement).value = "";
}

function dropped(event: DragEvent) {
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) void prepare(file);
}

async function save() {
  if (!candidate.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await putUserAvatar(candidate.value);
    avatar.refresh();
    candidate.value = null;
    fileName.value = "";
    avatar.closeEditor();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "头像保存失败";
  } finally {
    busy.value = false;
  }
}

async function reset() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await deleteUserAvatar();
    candidate.value = null;
    fileName.value = "";
    avatar.refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "恢复默认头像失败";
  } finally {
    busy.value = false;
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && avatar.editorOpen) close();
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  unregisterAppBack = registerAppBackHandler(() => {
    if (!avatar.editorOpen) return false;
    if (!busy.value) close();
    return true;
  }, APP_BACK_PRIORITY.overlay);
});
onBeforeUnmount(() => {
  unregisterAppBack?.();
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="cw-avatar-modal">
      <div
        v-if="avatar.editorOpen"
        class="cw-avatar-editor-backdrop"
        role="presentation"
        @mousedown.self="close"
      >
        <section
          class="cw-avatar-editor"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cw-avatar-editor-title"
        >
          <header class="cw-avatar-editor-header">
            <div>
              <p class="cw-avatar-editor-kicker">PERSONAL TOUCH</p>
              <h2 id="cw-avatar-editor-title">换一个你的头像</h2>
              <p>会显示在你发送的每一条消息旁边。</p>
            </div>
            <button type="button" class="cw-avatar-editor-close" aria-label="关闭" @click="close">×</button>
          </header>

          <div class="cw-avatar-editor-stage">
            <div class="cw-avatar-editor-orbit" aria-hidden="true">
              <span>✦</span><span>✦</span><span>✦</span>
            </div>
            <div class="cw-avatar-editor-preview">
              <span>{{ userInitials(ui.home) }}</span>
              <img :key="previewSrc" :src="previewSrc" alt="头像预览" />
            </div>
            <div class="cw-avatar-editor-preview-label">
              {{ candidate ? "新头像预览" : "当前头像" }}
            </div>
          </div>

          <button
            type="button"
            class="cw-avatar-dropzone"
            :class="{ 'is-dragging': dragging }"
            @click="input?.click()"
            @dragenter.prevent="dragging = true"
            @dragover.prevent="dragging = true"
            @dragleave.prevent="dragging = false"
            @drop.prevent="dropped"
          >
            <span class="cw-avatar-dropzone-icon">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v3A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <span>
              <strong>{{ busy ? "正在处理图片…" : "选择图片或拖到这里" }}</strong>
              <small>{{ fileName || "自动居中裁成正方形 · PNG / JPG / WebP / GIF · 最大 12 MB" }}</small>
            </span>
          </button>
          <input
            ref="input"
            class="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            @change="picked"
          />

          <p v-if="error" class="cw-avatar-editor-error" role="alert">{{ error }}</p>

          <footer class="cw-avatar-editor-actions">
            <button type="button" class="cw-avatar-editor-reset" :disabled="busy" @click="reset">
              恢复默认
            </button>
            <span />
            <button type="button" class="cw-avatar-editor-cancel" :disabled="busy" @click="close">取消</button>
            <button type="button" class="cw-avatar-editor-save" :disabled="!candidate || busy" @click="save">
              {{ busy ? "保存中…" : "使用这个头像" }}
            </button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cw-avatar-editor-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgb(3 7 18 / 0.64);
  backdrop-filter: blur(12px) saturate(0.85);
}
.cw-avatar-editor {
  width: min(460px, 100%);
  max-height: min(720px, calc(100dvh - 32px));
  overflow: auto;
  border: 1px solid color-mix(in srgb, var(--cw-border) 76%, white 12%);
  border-radius: 24px;
  color: var(--cw-text);
  background:
    radial-gradient(circle at 85% -5%, color-mix(in srgb, var(--cw-accent) 22%, transparent), transparent 38%),
    var(--cw-panel-bg);
  box-shadow: 0 30px 90px rgb(0 0 0 / 0.44), 0 1px 0 rgb(255 255 255 / 0.08) inset;
}
.cw-avatar-editor-header {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 24px 24px 8px;
}
.cw-avatar-editor-kicker {
  margin: 0 0 6px;
  color: var(--cw-accent);
  font: 700 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .16em;
}
.cw-avatar-editor-header h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 730;
  letter-spacing: -.02em;
}
.cw-avatar-editor-header p:last-child {
  margin: 5px 0 0;
  color: var(--cw-muted);
  font-size: 13px;
}
.cw-avatar-editor-close {
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  border: 1px solid var(--cw-border);
  border-radius: 11px;
  color: var(--cw-muted);
  background: color-mix(in srgb, var(--cw-panel-2) 74%, transparent);
  font-size: 23px;
  line-height: 1;
}
.cw-avatar-editor-close:hover { color: var(--cw-text); background: var(--cw-panel-2); }
.cw-avatar-editor-stage {
  position: relative;
  display: grid;
  justify-items: center;
  padding: 18px 24px 16px;
}
.cw-avatar-editor-preview {
  position: relative;
  width: 132px;
  height: 132px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 4px solid var(--cw-panel-bg);
  border-radius: 36px;
  color: white;
  background: linear-gradient(145deg, color-mix(in srgb, var(--cw-accent) 72%, #16a34a), #167c5d);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--cw-accent) 45%, var(--cw-border)), 0 18px 40px rgb(0 0 0 / .25);
  font-size: 34px;
  font-weight: 750;
}
.cw-avatar-editor-preview img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cw-avatar-editor-orbit {
  position: absolute;
  top: 7px;
  width: 176px;
  height: 154px;
  border: 1px dashed color-mix(in srgb, var(--cw-accent) 34%, transparent);
  border-radius: 50%;
  pointer-events: none;
}
.cw-avatar-editor-orbit span {
  position: absolute;
  color: var(--cw-accent);
  font-size: 10px;
}
.cw-avatar-editor-orbit span:nth-child(1) { left: 8px; top: 39px; }
.cw-avatar-editor-orbit span:nth-child(2) { right: 4px; top: 78px; font-size: 14px; }
.cw-avatar-editor-orbit span:nth-child(3) { left: 54px; bottom: -3px; opacity: .7; }
.cw-avatar-editor-preview-label {
  margin-top: 12px;
  padding: 4px 9px;
  border: 1px solid var(--cw-border);
  border-radius: 999px;
  color: var(--cw-muted);
  background: color-mix(in srgb, var(--cw-panel-2) 78%, transparent);
  font-size: 11px;
}
.cw-avatar-dropzone {
  width: calc(100% - 48px);
  min-height: 82px;
  margin: 2px 24px 0;
  padding: 15px;
  display: flex;
  align-items: center;
  gap: 13px;
  text-align: left;
  border: 1px dashed color-mix(in srgb, var(--cw-border) 72%, var(--cw-accent));
  border-radius: 16px;
  color: var(--cw-text);
  background: color-mix(in srgb, var(--cw-panel-2) 58%, transparent);
  transition: border-color .16s ease, background .16s ease, transform .16s ease;
}
.cw-avatar-dropzone:hover,
.cw-avatar-dropzone.is-dragging {
  border-color: var(--cw-accent);
  background: color-mix(in srgb, var(--cw-accent) 10%, var(--cw-panel-2));
  transform: translateY(-1px);
}
.cw-avatar-dropzone-icon {
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  display: grid;
  place-items: center;
  border-radius: 13px;
  color: var(--cw-accent);
  background: color-mix(in srgb, var(--cw-accent) 14%, transparent);
}
.cw-avatar-dropzone-icon svg { width: 22px; height: 22px; }
.cw-avatar-dropzone strong,
.cw-avatar-dropzone small { display: block; }
.cw-avatar-dropzone strong { font-size: 13px; font-weight: 670; }
.cw-avatar-dropzone small { max-width: 310px; margin-top: 4px; color: var(--cw-muted); font-size: 11px; line-height: 1.4; }
.cw-avatar-editor-error {
  margin: 10px 24px 0;
  padding: 8px 11px;
  border-radius: 10px;
  color: #fecaca;
  background: rgb(127 29 29 / .36);
  font-size: 12px;
}
.cw-avatar-editor-actions {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  gap: 9px;
  padding: 18px 24px 24px;
}
.cw-avatar-editor-actions button {
  min-height: 38px;
  padding: 0 14px;
  border-radius: 11px;
  font-size: 12px;
  font-weight: 630;
}
.cw-avatar-editor-reset { color: var(--cw-muted); }
.cw-avatar-editor-reset:hover { color: #ef4444; background: rgb(239 68 68 / .1); }
.cw-avatar-editor-cancel { border: 1px solid var(--cw-border); color: var(--cw-text); background: var(--cw-panel-2); }
.cw-avatar-editor-save { color: var(--cw-accent-text, white); background: var(--cw-accent); box-shadow: 0 8px 20px color-mix(in srgb, var(--cw-accent) 24%, transparent); }
.cw-avatar-editor-actions button:disabled { cursor: default; opacity: .45; box-shadow: none; }
.cw-avatar-modal-enter-active,
.cw-avatar-modal-leave-active { transition: opacity .18s ease; }
.cw-avatar-modal-enter-active .cw-avatar-editor,
.cw-avatar-modal-leave-active .cw-avatar-editor { transition: transform .18s ease, opacity .18s ease; }
.cw-avatar-modal-enter-from,
.cw-avatar-modal-leave-to { opacity: 0; }
.cw-avatar-modal-enter-from .cw-avatar-editor,
.cw-avatar-modal-leave-to .cw-avatar-editor { opacity: 0; transform: translateY(10px) scale(.98); }
@media (max-width: 560px) {
  .cw-avatar-editor-backdrop { align-items: end; padding: 0; }
  .cw-avatar-editor { width: 100%; max-height: 90dvh; border-radius: 24px 24px 0 0; }
  .cw-avatar-editor-header { padding: 21px 18px 6px; }
  .cw-avatar-dropzone { width: calc(100% - 36px); margin-inline: 18px; }
  .cw-avatar-editor-actions { grid-template-columns: 1fr 1fr; padding: 16px 18px 20px; }
  .cw-avatar-editor-actions > span { display: none; }
  .cw-avatar-editor-reset { grid-column: 1 / -1; order: 3; }
}
@media (prefers-reduced-motion: reduce) {
  .cw-avatar-modal-enter-active,
  .cw-avatar-modal-leave-active,
  .cw-avatar-modal-enter-active .cw-avatar-editor,
  .cw-avatar-modal-leave-active .cw-avatar-editor { transition: none; }
}
</style>
