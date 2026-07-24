<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { FileText, Paperclip, Send, X } from "@/components/icons";
import type { AgentKind, SessionListItem, SessionSettings, SessionStatus } from "@/types";
import SessionControls from "@/components/SessionControls.vue";
import { useComposerStore } from "@/stores/composer";
import { usePreferencesStore } from "@/stores/preferences";
import { useUiStore } from "@/stores/ui";
import { parseLocalSlashCommand } from "@/util/slash-commands";
const props = defineProps<{
  sessionId: string;
  agent: AgentKind;
  session: SessionListItem;
  settings?: SessionSettings;
  status?: SessionStatus;
  active: boolean;
  startLine: number;
  disabled?: boolean;
  pending?: boolean;
}>();
const emit = defineEmits<{ command: [text: string]; sendPending: [text: string] }>();
const composer = useComposerStore(); composer.ensure(props.sessionId);
const prefs = usePreferencesStore();
const ui = useUiStore();
const input = ref<HTMLInputElement>();
const isWechat = computed(() => prefs.prefs.messageDisplayStyle === "wechat");
// v2 intentionally retires the early prototype's persisted oversized heights.
// New values are still draggable and persistent, but every existing install
// gets one clean reference-sized first paint.
const COMPOSER_HEIGHT_KEY = "agent-webui:wechat-composer-height:v2";
function restoredComposerHeight(): number {
  try {
    const value = Number(localStorage.getItem(COMPOSER_HEIGHT_KEY));
    const viewportMax = typeof window === "undefined"
      ? 168
      : Math.max(118, Math.floor(window.innerHeight * 0.72));
    return Number.isFinite(value) && value >= 118
      ? Math.min(viewportMax, value)
      : 168;
  } catch {
    return 168;
  }
}
const wechatComposerHeight = ref(restoredComposerHeight());
const composerStyle = computed(() => ({
  "--cw-wechat-composer-height": `${wechatComposerHeight.value}px`,
}));
let resizeStartY = 0;
let resizeStartHeight = 168;
function resizeComposer(event: PointerEvent) {
  event.preventDefault();
  resizeStartY = event.clientY;
  resizeStartHeight = wechatComposerHeight.value;
  window.addEventListener("pointermove", onComposerResize);
  window.addEventListener("pointerup", stopComposerResize, { once: true });
  window.addEventListener("pointercancel", stopComposerResize, { once: true });
}
function onComposerResize(event: PointerEvent) {
  const max = Math.max(118, Math.floor(window.innerHeight * 0.72));
  wechatComposerHeight.value = Math.max(
    118,
    Math.min(max, Math.round(resizeStartHeight + resizeStartY - event.clientY)),
  );
}
function stopComposerResize() {
  window.removeEventListener("pointermove", onComposerResize);
  window.removeEventListener("pointerup", stopComposerResize);
  window.removeEventListener("pointercancel", stopComposerResize);
  try {
    localStorage.setItem(COMPOSER_HEIGHT_KEY, String(wechatComposerHeight.value));
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts.
  }
}
onBeforeUnmount(stopComposerResize);
const text = computed({ get: () => composer.textBySession[props.sessionId] ?? "", set: (value) => composer.setText(props.sessionId, value) });
async function send() {
  try {
    if (props.pending) { emit("sendPending", text.value); return; }
    if (parseLocalSlashCommand(text.value)) { emit("command", text.value); return; }
    await composer.send(props.sessionId, props.agent, props.active, props.startLine);
  } catch (error) { ui.toast(error instanceof Error ? error.message : "Could not send message", "error"); }
}
function keydown(event: KeyboardEvent) { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); } }
function addFiles(files: FileList | File[]) {
  const result = composer.addFiles(props.sessionId, files);
  for (const rejected of result.rejected) {
    ui.toast(rejected.reason === "too-large" ? `${rejected.file.name} exceeds the 10 MiB attachment limit` : `${rejected.file.name} is not a supported image or PDF`, "error");
  }
}
function chooseFiles(event: Event) {
  const target = event.target as HTMLInputElement;
  if (target.files) addFiles(target.files);
  target.value = "";
}
function paste(event: ClipboardEvent) {
  const files = [...(event.clipboardData?.files ?? [])];
  if (!files.length) return;
  event.preventDefault(); addFiles(files);
}
function openAttachment(item: { file: File; objectUrl?: string; preview?: string }) {
  if (item.preview) ui.lightboxUrl = item.preview;
  else if (item.file.type === "application/pdf" && item.objectUrl) window.open(item.objectUrl, "_blank", "noopener,noreferrer");
}
</script>
<template>
  <footer class="cw-composer cw-prompt-input" :style="composerStyle">
    <button
      v-if="isWechat"
      type="button"
      class="cw-wechat-resize-handle"
      aria-label="Resize composer"
      @pointerdown="resizeComposer"
    ><span /></button>
    <SessionControls v-if="isWechat && !pending" :session="session" :settings="settings" :status="status" />
    <div v-if="composer.attachments[sessionId]?.length" class="cw-attachments cw-image-draft-strip">
      <span v-for="item in composer.attachments[sessionId]" :key="item.id">
        <button v-if="item.preview" class="cw-attachment-preview" title="Open image" @click="openAttachment(item)"><img :src="item.preview" /></button>
        <button v-else class="cw-attachment-preview cw-pdf-preview" title="Open PDF" @click="openAttachment(item)"><FileText :size="18" /></button>
        <b>{{ item.file.name }}</b><button title="Remove attachment" @click="composer.removeFile(sessionId, item.id)"><X :size="13" /></button>
      </span>
    </div>
    <div v-if="!isWechat" class="cw-cc-composer">
      <input ref="input" type="file" hidden multiple accept="image/*,application/pdf" @change="chooseFiles" />
      <textarea
        v-model="text"
        class="cw-composer-textarea cw-cc-textarea"
        rows="1"
        :disabled="disabled"
        :placeholder="agent === 'codex' && active ? 'Steer the active turn…' : 'Message the agent…'"
        @keydown="keydown"
        @paste="paste"
      />
      <div class="cw-cc-toolbar">
        <button type="button" class="cw-attach-button cw-cc-tool-btn" title="Attach image or PDF" @click="input?.click()"><Paperclip :size="18" /></button>
        <SessionControls v-if="!pending" :session="session" :settings="settings" :status="status" />
        <span class="cw-cc-spacer" />
        <button
          type="button"
          class="cw-send-button cw-cc-send"
          title="Send"
          :disabled="disabled || composer.isSending(sessionId) || (!text.trim() && !composer.attachments[sessionId]?.length)"
          @click="send"
        ><Send :size="15" /></button>
      </div>
    </div>
    <div v-else class="cw-composer-row">
      <input ref="input" type="file" hidden multiple accept="image/*,application/pdf" @change="chooseFiles" />
      <button type="button" class="cw-attach-button" title="Attach image or PDF" @click="input?.click()"><Paperclip :size="18" /></button>
      <textarea
        v-model="text"
        class="cw-composer-textarea"
        rows="1"
        :disabled="disabled"
        :placeholder="agent === 'codex' && active ? 'Steer the active turn…' : 'Message the agent…'"
        @keydown="keydown"
        @paste="paste"
      />
      <button
        type="button"
        class="cw-send-button"
        :disabled="disabled || composer.isSending(sessionId) || (!text.trim() && !composer.attachments[sessionId]?.length)"
        @click="send"
      >发送(S)</button>
    </div>
  </footer>
</template>
