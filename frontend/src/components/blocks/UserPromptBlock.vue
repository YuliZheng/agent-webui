<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { renderUserMarkdown } from "../../render/markdown.js";
import { forkSession, rewindSession } from "../../api/sessions.js";
import { useDraftsStore } from "../../stores/drafts.js";
import { useUiStore } from "../../stores/ui.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { useNotificationsStore } from "../../stores/notifications.js";
import { useLightboxStore } from "../../stores/lightbox.js";
import { usePrefsStore } from "../../stores/prefs.js";
import { extractAttachedImages } from "../../util/extract-images.js";
import { APP_BACK_PRIORITY, registerAppBackHandler } from "../../util/app-back.js";
import { setPwaLayerActive } from "../../util/pwa-history.js";
import ChatImage from "./ChatImage.vue";
import UserAvatar from "../UserAvatar.vue";

const props = defineProps<{
  node: { record: Record<string, unknown> };
  sessionId?: string;
  preview?: boolean;
  pendingStatus?: "sending" | "steered" | undefined;
  pendingImageCount?: number;
}>();

const drafts = useDraftsStore();
const ui = useUiStore();
const sessions = useSessionsStore();
const notifications = useNotificationsStore();
const lightbox = useLightboxStore();
const prefs = usePrefsStore();
const preview = computed(() => props.preview === true);
// claude-code mirrors the real Claude Code prompt: attachments render as small
// chips (thumb + name + W×H), not big preview tiles.
const compactImages = computed(() => prefs.messageDisplayStyle === "claude-code");
const rawText = computed(() => {
  const m = (props.node.record.message as { content?: unknown } | undefined)?.content;
  if (typeof m === "string") return m;
  if (Array.isArray(m)) {
    return m.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
  }
  return "";
});
const extracted = computed(() => extractAttachedImages(rawText.value));
const text = computed(() => extracted.value.text);
const structuredImages = computed(() => {
  const sessionId = props.sessionId;
  const record = props.node.record;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!sessionId || !Array.isArray(content)) return [];
  const recordSourceIndex = Number(record.__agentWebuiSourceIndex);
  const out: Array<{ url: string; sid: string; filename: string }> = [];
  let imageOrdinal = 0;
  for (const raw of content) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const block = raw as Record<string, any>;
    if (block.type !== "image") continue;
    const ordinal = imageOrdinal++;
    const source = block.source && typeof block.source === "object" && !Array.isArray(block.source)
      ? block.source as Record<string, any>
      : {};
    const lineIndex = Number.isSafeInteger(Number(source.lineIndex))
      ? Number(source.lineIndex)
      : recordSourceIndex;
    const sourceImageIndex = Number.isSafeInteger(Number(source.imageIndex))
      ? Number(source.imageIndex)
      : ordinal;
    if (!Number.isSafeInteger(lineIndex) || lineIndex < 0 || !Number.isSafeInteger(sourceImageIndex) || sourceImageIndex < 0) continue;
    const mediaType = typeof source.media_type === "string"
      ? source.media_type
      : typeof source.mediaType === "string" ? source.mediaType : "image";
    const extension = mediaType === "image/jpeg"
      ? "jpg"
      : (mediaType.split("/")[1]?.replace(/[^a-z0-9]+/gi, "") || "img");
    const filename = typeof block.name === "string" && block.name.trim()
      ? block.name
      : `image-${ordinal + 1}.${extension}`;
    out.push({
      sid: sessionId,
      filename,
      url: `/api/sessions/${encodeURIComponent(sessionId)}/input-image/${lineIndex}/${sourceImageIndex}`,
    });
  }
  return out;
});
const images = computed(() => {
  const seen = new Set<string>();
  return [...structuredImages.value, ...extracted.value.images].filter(image => {
    if (seen.has(image.url)) return false;
    seen.add(image.url);
    return true;
  });
});
const pdfs = computed(() => extracted.value.pdfs);
const pendingImageCount = computed(() => Math.max(0, Math.floor(props.pendingImageCount ?? 0)));
const hasAttachments = computed(() =>
  images.value.length > 0 ||
  pdfs.value.length > 0 ||
  pendingImageCount.value > 0
);
// WeChat skin splits an image+text prompt into two bubbles (like two WeChat
// messages), but MessageList's entry-level avatar only aligns with the first
// (image) bubble. Give the text bubble its own avatar so each bubble reads as
// its own message — the absolute-positioned span lands exactly in the avatar
// column the band layout already reserves. Only needed when BOTH bubbles
// render; single-bubble prompts are covered by the entry avatar.
const wechatBubbleAvatar = computed(() =>
  prefs.messageDisplayStyle === "wechat" &&
  hasAttachments.value &&
  text.value.length > 0
);
const html = computed(() => renderUserMarkdown(text.value));
const promptCollapsePx = computed(() => (prefs.messageDisplayStyle === "claude-code" ? 54 : 180));
const promptBody = ref<HTMLDivElement | null>(null);
const collapsed = ref(true);
const canCollapse = ref(false);
const previewLikelyCollapsible = computed(() =>
  preview.value && (images.value.length > 0 || text.value.length > 90 || text.value.includes("\n")),
);
const collapsible = computed(() => canCollapse.value || previewLikelyCollapsible.value);
const bodyCollapsed = computed(() => preview.value ? collapsed.value : (collapsible.value && collapsed.value));
let resizeObserver: ResizeObserver | null = null;
let unregisterAppBack: (() => void) | undefined;

function measureCollapse() {
  const el = promptBody.value;
  if (!el) { canCollapse.value = false; return; }
  canCollapse.value = el.scrollHeight > promptCollapsePx.value + 8;
}

onMounted(() => {
  unregisterAppBack = registerAppBackHandler(() => {
    if (!menuOpen.value) return false;
    closeMenu();
    return true;
  }, APP_BACK_PRIORITY.menu);
  resizeObserver = new ResizeObserver(measureCollapse);
  if (promptBody.value) resizeObserver.observe(promptBody.value);
  void nextTick(measureCollapse);
});
onBeforeUnmount(() => {
  unregisterAppBack?.();
  resizeObserver?.disconnect();
  resizeObserver = null;
});
watch([text, () => images.value.length, promptCollapsePx], async () => {
  await nextTick();
  measureCollapse();
});
const uuid = computed(() => {
  const u = props.node.record.uuid;
  return typeof u === "string" ? u : null;
});

const busy = ref(false);

async function rewind() {
  if (!props.sessionId || !uuid.value || busy.value) return;
  if (!confirm("Rewind this session to before this message? Everything after will be deleted.")) return;
  busy.value = true;
  try {
    const r = await rewindSession(props.sessionId, uuid.value);
    drafts.set(props.sessionId, r.prefillText);
    // No explicit resetAndReengage here: the backend's jsonl-tail detects
    // the truncation (~100ms via fs.watch, fallback 2s via poll) and pushes
    // a stream-reset on the existing session subscription. live.ts handles
    // that by clearing the cache, then the same tail re-streams from byte 0
    // to repopulate. Running resetAndReengage in parallel created a race
    // where the LATE stream-reset from the old subscription arrived AFTER
    // the re-engage's replay had already filled the cache, blanking the
    // UI mid-conversation ("一直加载新消息往下，然后突然黑掉").
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Rewind failed" });
  } finally {
    busy.value = false;
  }
}

async function fork() {
  if (!props.sessionId || !uuid.value || busy.value) return;
  busy.value = true;
  try {
    const r = await forkSession(props.sessionId, uuid.value);
    // The backend indexes the fork before resolving and normally pushes a
    // session-added event first. Cover the inverse network ordering with a
    // minimal provisional row, then navigate immediately; a full list refresh
    // is reconciliation work and must not sit on the user's critical path.
    if (!sessions.byId[r.newSessionId]) {
      const source = sessions.byId[props.sessionId];
      if (source) {
        const now = new Date().toISOString();
        sessions.addOrTouch({
          id: r.newSessionId,
          cwd: source.cwd,
          mtime: now,
          size: 0,
          ...(source.agent ? { agent: source.agent } : {}),
          parentSessionId: props.sessionId,
          preview: null,
          lastTurnAt: now,
        });
      }
    }
    drafts.set(r.newSessionId, r.prefillText);
    ui.select(r.newSessionId);
    void sessions.fetchAll();
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Fork failed" });
  } finally {
    busy.value = false;
  }
}

// Touch long-press → action menu (rewind / fork). The hover-reveal buttons
// (.cw-user-prompt-actions) are display:none on touch devices (no hover), so
// without this mobile has no way to reach rewind/fork. WeChat pattern: press
// and hold a bubble to pop a small floating menu. Desktop keeps the hover
// buttons; long-press is gated to pointerType==="touch" so a mouse never
// triggers it (and never fights text selection).
const actionable = computed(() => !!(props.sessionId && uuid.value));
const menuOpen = ref(false);
watch(menuOpen, open => {
  setPwaLayerActive(
    `message-menu:${uuid.value ?? "pending"}`,
    open,
    props.sessionId ?? ui.selectedSessionId,
  );
});
const menuX = ref(0);
const menuY = ref(0);
const menuEl = ref<HTMLDivElement | null>(null);
const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 10;
const MENU_W = 168;
const MENU_H = 92;
let pressTimer: number | null = null;
let pressStart: { x: number; y: number } | null = null;

function clearPress() {
  if (pressTimer != null) { clearTimeout(pressTimer); pressTimer = null; }
  pressStart = null;
}

function onPressDown(e: PointerEvent) {
  if (!actionable.value || e.pointerType !== "touch" || preview.value) return;
  pressStart = { x: e.clientX, y: e.clientY };
  if (pressTimer != null) clearTimeout(pressTimer);
  pressTimer = window.setTimeout(() => {
    pressTimer = null;
    const s = pressStart;
    pressStart = null;
    if (s) openMenuAt(s.x, s.y);
  }, LONG_PRESS_MS);
}

function onPressMove(e: PointerEvent) {
  if (!pressStart) return;
  if (Math.abs(e.clientX - pressStart.x) > MOVE_CANCEL_PX ||
      Math.abs(e.clientY - pressStart.y) > MOVE_CANCEL_PX) {
    clearPress();
  }
}

function openMenuAt(x: number, y: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  menuX.value = Math.max(8, Math.min(x, vw - MENU_W - 8));
  menuY.value = Math.max(8, Math.min(y, vh - MENU_H - 8));
  menuOpen.value = true;
  try { navigator.vibrate?.(10); } catch { /* unsupported */ }
  // Bind dismiss listeners on the NEXT tick so the gesture's own trailing
  // events (the press-release click / pointerup) don't immediately close it.
  void nextTick(() => {
    document.addEventListener("pointerdown", onDocPointerDown, true);
    window.addEventListener("scroll", closeMenu, true);
  });
}

function onDocPointerDown(e: PointerEvent) {
  if (menuEl.value && e.target instanceof Node && menuEl.value.contains(e.target)) return;
  closeMenu();
}

function closeMenu() {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  window.removeEventListener("scroll", closeMenu, true);
}

async function menuRewind() {
  closeMenu();
  await rewind();
}

async function menuFork() {
  closeMenu();
  await fork();
}

onBeforeUnmount(() => {
  clearPress();
  closeMenu();
});

function toggleCollapsed(event: MouseEvent) {
  collapsed.value = !collapsed.value;
  if (event.detail > 0) {
    (event.currentTarget as HTMLElement | null)?.blur();
  }
}
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
    :data-visual-uuid="uuid || ''"
    @pointerdown="onPressDown"
    @pointermove="onPressMove"
    @pointerup="clearPress"
    @pointercancel="clearPress"
  >
    <div
      v-if="hasAttachments"
      class="cw-user-prompt-image-bubble cw-user-prompt px-4 py-2 border-l-4 relative"
    >
      <div class="cw-user-prompt-images flex flex-wrap gap-2">
        <ChatImage
          v-for="img in images"
          :key="img.url"
          :src="img.url"
          :alt="img.filename"
          :compact="compactImages"
          @open="lightbox.open(img.url, img.filename)"
        />
        <span
          v-for="pdf in pdfs"
          :key="pdf.filename"
          class="cw-user-prompt-pdf-chip inline-flex items-center gap-1.5 px-2 py-1 rounded border border-[var(--cw-border)]  bg-[var(--cw-panel-2)]  text-xs"
          :title="pdf.filename"
        ><span aria-hidden="true">📄</span><span class="truncate max-w-40">{{ pdf.filename }}</span></span>
        <span
          v-if="pendingImageCount"
          class="cw-pending-attachment-chip"
        ><span aria-hidden="true">📷</span><span>{{ pendingImageCount }} image{{ pendingImageCount === 1 ? "" : "s" }}</span></span>
      </div>
    </div>
    <div
      v-if="text"
      class="cw-user-prompt-text-bubble cw-user-prompt px-4 py-2 border-l-4 relative"
    >
      <span v-if="wechatBubbleAvatar" class="cw-bubble-avatar">
        <UserAvatar />
      </span>
      <div
        ref="promptBody"
        class="cw-user-prompt-body relative"
        :class="bodyCollapsed ? 'cw-user-prompt-collapsed' : ''"
      >
        <div class="prose prose-sm dark:prose-invert max-w-none break-words" v-html="html" />
        <div
          v-if="!preview && collapsible && collapsed"
          class="cw-user-prompt-fade pointer-events-none absolute left-0 right-0 bottom-0 h-10"
        />
      </div>
      <button
        v-if="collapsible"
        type="button"
        class="cw-user-prompt-toggle mt-2 text-xs font-medium opacity-70 underline underline-offset-2"
        @click="toggleCollapsed"
      >{{ collapsed ? "Show more" : "Show less" }}</button>
    </div>
    <div
      v-if="!text && !hasAttachments"
      class="cw-user-prompt px-4 py-2 border-l-4 relative"
    />
    <div v-if="pendingStatus" class="cw-pending-prompt-status" role="status">
      <span class="cw-pending-prompt-dot" aria-hidden="true" />
      <span>{{ pendingStatus === "steered" ? "steered" : "sending…" }}</span>
    </div>
    <div
      v-if="!preview && sessionId && uuid"
      class="cw-user-prompt-actions"
    >
      <button
        class="cw-user-prompt-action"
        :disabled="busy"
        @click="rewind"
        title="Rewind: discard this and everything after, prefill composer"
      >↺ Rewind</button>
      <button
        class="cw-user-prompt-action"
        :disabled="busy"
        @click="fork"
        title="Fork: create a new session branched from this point"
      >⑂ Fork</button>
    </div>
  </div>
  <!-- Touch long-press menu. Teleported to body with an explicit z-index so it
       escapes the timeline's stacking context (same rule as the modals). -->
  <Teleport to="body">
    <div
      v-if="menuOpen"
      ref="menuEl"
      class="cw-prompt-action-menu"
      :style="{ top: menuY + 'px', left: menuX + 'px' }"
      @pointerdown.stop
    >
      <button class="cw-prompt-action-menu-item" :disabled="busy" @click="menuRewind">↺ Rewind</button>
      <button class="cw-prompt-action-menu-item" :disabled="busy" @click="menuFork">⑂ Fork</button>
    </div>
  </Teleport>
</template>
