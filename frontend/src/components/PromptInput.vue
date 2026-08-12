<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { isForwardedSlashCommand, newSession, sendPrompt, type OutgoingImage } from "../api/sessions.js";
import { WsError } from "../api/ws.js";
import { useSessionsStore } from "../stores/sessions.js";
import { useDraftsStore } from "../stores/drafts.js";
import { useImageDraftsStore, type PendingImage } from "../stores/image-drafts.js";
import { usePrefsStore } from "../stores/prefs.js";
import { useNotificationsStore } from "../stores/notifications.js";
import { useUiStore } from "../stores/ui.js";
import { useLightboxStore } from "../stores/lightbox.js";
import { usePromptPendingStore } from "../stores/prompt-pending.js";
import { useSessionCacheStore } from "../stores/session-cache.js";
import { useSessionSkillsStore } from "../stores/session-skills.js";
import PillRow from "./PillRow.vue";
import { useSlashMenu } from "../composables/useSlashMenu.js";
import SlashCommandMenu from "./SlashCommandMenu.vue";
import { useSessionSettingsStore } from "../stores/session-settings.js";
import { promotePendingDraft } from "../stores/live.js";
import { parseLocalCommand, runLocalCommand, latestContextUsage, HIDDEN_CLI_COMMANDS } from "../util/local-commands.js";
import { idempotencyFingerprint } from "../util/idempotency.js";
import { APP_BACK_PRIORITY, registerAppBackHandler } from "../util/app-back.js";
import { setPwaLayerActive } from "../util/pwa-history.js";
import { promptAttachmentError } from "../util/attachment-limits.js";
import { preparePromptAttachment } from "../util/image-compression.js";

const props = defineProps<{ sessionId: string; running: boolean }>();
const emit = defineEmits<{ "mobile-composer-focus": [] }>();

const drafts = useDraftsStore();
const imageDrafts = useImageDraftsStore();
const prefs = usePrefsStore();
const sessions = useSessionsStore();
let unregisterAppBack: (() => void) | undefined;

// Returns the trigger keyword IF it should be appended to the outgoing
// message, or "" if not (off, or already present in the typed text).
function pendingThinkingTrigger(text: string): string {
  const t = prefs.thinkingTrigger;
  if (!t) return "";
  if (text && text.toLowerCase().includes(t)) return "";
  return t;
}

// Text-only convenience: returns the prompt with the trigger appended at
// the end.
function applyThinkingTrigger(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const trig = pendingThinkingTrigger(trimmed);
  return trig ? `${trimmed} ${trig}` : text;
}

const notifications = useNotificationsStore();
const ui = useUiStore();
const lightbox = useLightboxStore();
const promptPending = usePromptPendingStore();
const sessionCache = useSessionCacheStore();
const sessionSettings = useSessionSettingsStore();
const sessionSkills = useSessionSkillsStore();

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ACCEPTED_ATTACHMENT_MIME = /^(?:image\/(?:png|jpe?g|gif|webp|bmp)|application\/pdf)$/i;
const VIDEO_ATTACHMENT_MIME = /^video\//i;
const VIDEO_ATTACHMENT_EXTENSION = /\.(?:mp4|mov|m4v|webm|avi|mkv|3gp)$/i;
const PDF_MIME = "application/pdf";

const pendingImages = computed(() => imageDrafts.list(props.sessionId));
const hasPendingImages = computed(() => pendingImages.value.length > 0);
const currentAgent = computed(() => sessions.byId[props.sessionId]?.agent ?? "claude");
const isCodexRunning = computed(() => props.running && currentAgent.value === "codex");
const promptPlaceholder = computed(() => {
  if (!props.running) return "Type a message…";
  return isCodexRunning.value
    ? "Running… (Send into current turn)"
    : "Running… (Send to queue)";
});
const sendActionTitle = computed(() => {
  if (!props.running) return "Send";
  return isCodexRunning.value ? "Send into current turn" : "Send to queue";
});
const sendOriginalAttachments = ref(false);

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const attachmentSizeSummary = computed(() => {
  const attachments = pendingImages.value;
  if (!attachments.length) return "";
  const original = attachments.reduce((sum, item) => sum + (item.originalBytes ?? item.bytes), 0);
  const outgoing = attachments.reduce((sum, item) => sum + item.bytes, 0);
  const compressed = attachments.some(item => item.compressed);
  return compressed
    ? `${formatAttachmentBytes(original)} → ${formatAttachmentBytes(outgoing)}`
    : formatAttachmentBytes(outgoing);
});

function attachmentTitle(img: PendingImage): string {
  const current = formatAttachmentBytes(img.bytes);
  const original = img.originalBytes ?? img.bytes;
  const size = img.compressed ? `${formatAttachmentBytes(original)} → ${current}` : current;
  return `${img.name ?? img.mime} · ${size}`;
}

const FILE_READ_TIMEOUT_MS = 45_000;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = window.setTimeout(() => {
      if (reader.readyState === FileReader.LOADING) reader.abort();
      finish(() => reject(new Error("Reading this attachment timed out. Try exporting it as a JPEG or sending a screenshot.")));
    }, FILE_READ_TIMEOUT_MS);
    reader.onerror = () => finish(() => reject(reader.error ?? new Error("FileReader error")));
    reader.onabort = () => finish(() => reject(new Error("Attachment reading was interrupted.")));
    reader.onload = () => finish(() => resolve(reader.result as string));
    reader.readAsDataURL(blob);
  });
}

function isVideoAttachment(blob: Blob, name?: string): boolean {
  return VIDEO_ATTACHMENT_MIME.test(blob.type) || VIDEO_ATTACHMENT_EXTENSION.test(name ?? "");
}

async function ingestAttachmentBlob(blob: Blob, name?: string) {
  // Stop before compression, FileReader, or size checks: videos are exposed in
  // the picker only so an attempted selection receives a useful explanation.
  if (isVideoAttachment(blob, name)) {
    notifications.pushError(
      "暂不支持发送视频，请改发关键截图。",
      { title: "视频未添加" },
    );
    return;
  }
  let prepared;
  try {
    prepared = await preparePromptAttachment(blob, name, sendOriginalAttachments.value);
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Photo compression failed" });
    return;
  }
  blob = prepared.blob;
  name = prepared.name;
  if (!ACCEPTED_ATTACHMENT_MIME.test(blob.type)) {
    const looksLikeHeic = /(?:heic|heif)/i.test(`${blob.type} ${name ?? ""}`);
    notifications.pushError(
      looksLikeHeic
        ? "HEIC/HEIF or Live Photo is not supported. Export it as JPEG or send a screenshot."
        : `Unsupported file type: ${blob.type || "unknown"}`,
      { title: "Attachment not added" },
    );
    return;
  }
  if (blob.size > MAX_ATTACHMENT_BYTES) {
    notifications.pushError(`File too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)`);
    return;
  }
  const attachmentError = promptAttachmentError(
    [...pendingImages.value, { bytes: blob.size }],
    currentAgent.value,
  );
  if (attachmentError) {
    notifications.pushError(attachmentError, { title: "附件未添加" });
    return;
  }
  try {
    // Read once. The previous implementation ran two FileReaders per photo,
    // which doubled peak memory and could freeze mobile Safari on multi-select.
    const dataUrl = await blobToDataUrl(blob);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("The selected attachment could not be decoded.");
    const base64 = dataUrl.slice(comma + 1);
    imageDrafts.add(props.sessionId, {
      mime: blob.type,
      base64,
      dataUrl,
      bytes: blob.size,
      originalBytes: prepared.originalBytes,
      compressed: prepared.compressed,
      ...(name ? { name } : {}),
    });
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "File read failed" });
  }
}

function isPdfDraft(mime: string): boolean {
  return mime.toLowerCase() === PDF_MIME;
}

async function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items || items.length === 0) return;
  const blobs: { blob: Blob; name?: string }[] = [];
  for (const item of items) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f && (ACCEPTED_ATTACHMENT_MIME.test(f.type) || isVideoAttachment(f, f.name))) {
        blobs.push({ blob: f, name: f.name });
      }
    }
  }
  if (blobs.length === 0) return;
  e.preventDefault();
  for (const { blob, name } of blobs) {
    await ingestAttachmentBlob(blob, name);
  }
}

// Desktop keeps the combined picker. Mobile uses separate inputs behind our
// own WeChat-style tray so tapping + does not first show Android's unstyleable
// "Camera / Photos" chooser.
const fileInputRef = ref<HTMLInputElement | null>(null);
const galleryInputRef = ref<HTMLInputElement | null>(null);
const cameraInputRef = ref<HTMLInputElement | null>(null);
const browseInputRef = ref<HTMLInputElement | null>(null);
const attachmentTrayOpen = ref(false);

function openFilePicker() { fileInputRef.value?.click(); }

function toggleAttachmentTray() {
  if (isDesktopViewport.value) {
    attachmentTrayOpen.value = false;
    openFilePicker();
    return;
  }
  attachmentTrayOpen.value = !attachmentTrayOpen.value;
  if (attachmentTrayOpen.value) {
    textareaRef.value?.blur();
    stopWechatComposerResize();
    // The tray takes height away from the message scroller just like the
    // software keyboard does. Ask the list to keep the latest message visible
    // while Vue mounts the tray and the mobile viewport finishes reflowing.
    emit("mobile-composer-focus");
  }
}

function openGalleryPicker() {
  attachmentTrayOpen.value = false;
  galleryInputRef.value?.click();
}

function openCameraPicker() {
  attachmentTrayOpen.value = false;
  cameraInputRef.value?.click();
}

function openFileBrowser() {
  attachmentTrayOpen.value = false;
  browseInputRef.value?.click();
}

async function onFileInput(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  // Release the native picker immediately. A slow or invalid item must not
  // leave the input wedged or prevent selecting the same files again.
  input.value = "";
  for (const f of files) await ingestAttachmentBlob(f, f.name);
}

function removeImage(imgId: string) {
  imageDrafts.remove(props.sessionId, imgId);
}

function previewImage(img: PendingImage) {
  if (isPdfDraft(img.mime)) return;
  lightbox.open(img.dataUrl, img.name ?? "待发送图片");
}

function imagePayload(): OutgoingImage[] {
  return pendingImages.value.map((p) => ({ mime: p.mime, data: p.base64 }));
}

const text = computed<string>({
  get: () => drafts.text(props.sessionId),
  set: (v) => drafts.set(props.sessionId, v),
});

const caret = ref(0);
const sessionIdRef = computed(() => props.sessionId);
const slash = useSlashMenu({ text, caret, sessionId: sessionIdRef });
watch(
  [() => slash.open.value, attachmentTrayOpen],
  ([slashOpen, trayOpen]) => {
    setPwaLayerActive(
      `composer-overlay:${props.sessionId}`,
      slashOpen || trayOpen,
      props.sessionId,
    );
  },
);

// Recompute the menu whenever the caret might have moved or content changed.
function syncSlash() {
  caret.value = textareaRef.value?.selectionStart ?? text.value.length;
  void slash.refresh();
}

async function providerSlashCommandsFor(raw: string, sid: string): Promise<string[]> {
  if (!raw.startsWith("/")) return [];
  const s = sessions.byId[sid];
  await sessionSkills.ensureLoaded(sid, {
    ...(s?.cwd ? { cwd: s.cwd } : {}),
    ...(s?.agent ? { agent: s.agent } : {}),
  });
  // Drop the hidden terminal-only built-ins so escapeSlashCommand treats them
  // as unknown (space-prepend) — they must never reach the CLI.
  return sessionSkills.list(sid).map((s) => s.name)
    .filter((n) => !HIDDEN_CLI_COMMANDS.has(n.toLowerCase()));
}

// Apply a slash-menu selection: write the new text to the drafts store and
// restore the caret after the inserted "/name ".
async function applySlashAccept(index?: number) {
  const res = index === undefined ? slash.accept() : slash.accept(index);
  if (!res) return;
  drafts.set(props.sessionId, res.text);
  slash.close();
  await nextTick();
  const ta = textareaRef.value;
  if (ta) {
    ta.focus();
    ta.setSelectionRange(res.caret, res.caret);
  }
  caret.value = res.caret;
  autoResizeTextarea();
}

const textareaRef = ref<HTMLTextAreaElement | null>(null);
const WECHAT_COMPOSER_DEFAULT_PX = 142;
const WECHAT_COMPOSER_MIN_PX = 96;
// Floor for the drag ceiling. The real ceiling is viewport-relative (see
// wechatComposerMaxPx) so a tall window lets the composer be pulled tall; this
// static value only applies when window height is unavailable (SSR/tests).
const WECHAT_COMPOSER_MAX_FLOOR_PX = 320;
// Composer height is a per-device ergonomic pref, not per-session. Persist it
// to localStorage so a remount (new session from the empty state, refresh, or
// a fresh PWA window) reloads the user's last height instead of snapping back
// to the default.
const WECHAT_COMPOSER_HEIGHT_KEY = "cw:wechat-composer-height";
function loadComposerHeight(): number {
  try {
    const raw = localStorage.getItem(WECHAT_COMPOSER_HEIGHT_KEY);
    if (raw) return clampComposerHeight(Number(raw));
  } catch { /* ignore */ }
  return WECHAT_COMPOSER_DEFAULT_PX;
}
function saveComposerHeight(v: number) {
  try { localStorage.setItem(WECHAT_COMPOSER_HEIGHT_KEY, String(v)); } catch { /* ignore */ }
}
const wechatComposerHeight = ref(loadComposerHeight());
const wechatResizing = ref(false);
let wechatResizeStartY = 0;
let wechatResizeStartHeight = WECHAT_COMPOSER_DEFAULT_PX;

const isWechatComposer = computed(() => prefs.messageDisplayStyle === "wechat");
const isDesktopViewport = ref(false);
let desktopViewportQuery: MediaQueryList | null = null;
const composerStyle = computed(() =>
  isWechatComposer.value
    ? { "--cw-wechat-composer-height": `${wechatComposerHeight.value}px` }
    : undefined,
);
const showSendButton = computed(() =>
  hasComposerContent.value || (isWechatComposer.value && isDesktopViewport.value),
);
const sendLabel = computed(() => (isWechatComposer.value && isDesktopViewport.value ? "发送(S)" : "Send"));
const attachmentButtonLabel = computed(() => hasPendingImages.value
  ? `继续添加附件，当前 ${pendingImages.value.length} 个`
  : "添加附件");

function updateDesktopViewport(e?: MediaQueryList | MediaQueryListEvent) {
  isDesktopViewport.value = !!e?.matches;
  if (isDesktopViewport.value) attachmentTrayOpen.value = false;
}

function onTextareaFocus() {
  attachmentTrayOpen.value = false;
  if (!isDesktopViewport.value) emit("mobile-composer-focus");
}

// Drag ceiling scales with the window: up to 72% of viewport height (matching
// the CSS `max-height` on .cw-prompt-input), never below the static floor. This
// is what lets the composer be pulled much taller on a big screen.
function wechatComposerMaxPx(): number {
  const vh = typeof window !== "undefined" ? window.innerHeight : 0;
  return vh > 0 ? Math.max(WECHAT_COMPOSER_MAX_FLOOR_PX, Math.round(vh * 0.72)) : WECHAT_COMPOSER_MAX_FLOOR_PX;
}

function clampComposerHeight(v: number): number {
  return Math.max(WECHAT_COMPOSER_MIN_PX, Math.min(wechatComposerMaxPx(), Math.round(v)));
}

function onWechatComposerResizeMove(e: PointerEvent) {
  if (!wechatResizing.value) return;
  const dy = wechatResizeStartY - e.clientY;
  wechatComposerHeight.value = clampComposerHeight(wechatResizeStartHeight + dy);
}

function stopWechatComposerResize() {
  if (!wechatResizing.value) return;
  wechatResizing.value = false;
  window.removeEventListener("pointermove", onWechatComposerResizeMove);
  window.removeEventListener("pointerup", stopWechatComposerResize);
  window.removeEventListener("pointercancel", stopWechatComposerResize);
  saveComposerHeight(wechatComposerHeight.value);
}

function startWechatComposerResize(e: PointerEvent) {
  if (!isWechatComposer.value) return;
  e.preventDefault();
  wechatResizing.value = true;
  wechatResizeStartY = e.clientY;
  wechatResizeStartHeight = wechatComposerHeight.value;
  window.addEventListener("pointermove", onWechatComposerResizeMove);
  window.addEventListener("pointerup", stopWechatComposerResize);
  window.addEventListener("pointercancel", stopWechatComposerResize);
}

function resetWechatComposerHeight() {
  wechatComposerHeight.value = WECHAT_COMPOSER_DEFAULT_PX;
  saveComposerHeight(WECHAT_COMPOSER_DEFAULT_PX);
}

// Per-session derived predicates
const isInflightHere = computed(() => drafts.isInflight(props.sessionId));
const canSend = computed(
  () => text.value.trim().length > 0 || hasPendingImages.value,
);
const hasComposerContent = computed(
  () => text.value.trim().length > 0 || hasPendingImages.value,
);

function friendlySendError(err: unknown): string {
  if (err && typeof err === "object" && (err as { name?: string }).name === "AbortError") {
    return "Send timed out — refresh the page if SSO needs re-auth, then try again. Your text is kept.";
  }
  if (err instanceof WsError && err.code === 0) {
    if (/timed out/i.test(err.message)) {
      return "Send confirmation timed out. The message may already have arrived; check the conversation before retrying. Your text is kept.";
    }
    return "The connection changed before send confirmation arrived. Your text is kept; check the conversation before retrying.";
  }
  return err instanceof Error ? err.message : String(err);
}

function sendErrorTitle(err: unknown): string {
  return err instanceof WsError && err.code === 0 ? "Send not confirmed" : "Send failed";
}

async function send() {
  const sid = props.sessionId;
  // This lock is taken synchronously, before nextTick or provider metadata
  // lookup. Button disabling alone cannot prevent a second Enter/click in the
  // same render turn.
  if (!canSend.value || drafts.isInflight(sid)) return;
  drafts.beginInflight(sid);
  try {
    await sendOnce(sid);
  } catch (err) {
    notifications.pushError(friendlySendError(err), { title: sendErrorTitle(err) });
  } finally {
    drafts.endInflight(sessions.resolvePromoted(sid));
    // Re-enabling the textarea after the in-flight window does NOT restore
    // focus on its own — disabling a focused element blurs it, so the caret
    // is lost and the user can't fire off a second message without clicking
    // back in. Restore focus on desktop. Skip touch (would pop the on-screen
    // keyboard), and bail if the user switched sessions mid-send.
    if (isDesktopLike && sid === props.sessionId) {
      await nextTick();
      textareaRef.value?.focus();
    }
  }
}

async function sendOnce(sid: string) {
  attachmentTrayOpen.value = false;
  // Webui-local control commands (/model, /context) branch off here: handled
  // in the browser, never sent to the agent. Only on a real session —
  // pending drafts have no id to control.
  if (!sessions.isPending(sid)) {
    const isCodex = sessions.byId[sid]?.agent === "codex";
    const cmd = parseLocalCommand(text.value, isCodex);
    if (cmd) {
      const model = isCodex
        ? sessionSettings.effectiveCodex(sid).model
        : sessionSettings.effective(sid).model;
      const contextUsage = latestContextUsage(
        sessionCache.bySession[sid]?.lines ?? [],
        isCodex,
        model,
        prefs.autoCompactWindow,
        prefs.codexAutoCompactWindow,
      );
      await runLocalCommand(cmd, {
        sessionId: sid,
        isCodex,
        model,
        ctxTokens: contextUsage.tokens,
        ctxLimit: contextUsage.limit,
        ctxReportedTokens: contextUsage.reportedTokens,
        ctxEstimatedTokens: contextUsage.estimatedTokens,
        ctxContributors: contextUsage.contributors,
        lines: sessionCache.bySession[sid]?.lines ?? [],
      });
      drafts.clearIfMatches(sid, text.value);
      return;
    }
  }
  const agent = sessions.byId[sid]?.agent ?? "claude";
  const attachmentError = promptAttachmentError(pendingImages.value, agent);
  if (attachmentError) throw new Error(attachmentError);
  const snapText = text.value;
  const snapImages = imagePayload();
  const snapImageIds = pendingImages.value.map((image) => image.id);
  // Pending draft → spawn a new session via newSession instead of POSTing
  // a prompt to a (non-existent) session id. live.ts will swap selection
  // to the real id when the file watcher fires session-added.
  const draftCwd = sessions.isPending(sid) ? sessions.byId[sid]?.cwd : null;
  // Paint before any provider metadata lookup or backend round trip. Pending
  // drafts keep the same immediate feedback; live.ts transfers the chip to
  // the real session id when session-added reconciles the draft.
  const showOptimistic = snapText.trim().length > 0 || snapImages.length > 0;
  let pendId: string | null = null;
  if (showOptimistic) {
    // Sending from a conversation means everything currently on screen has
    // been read. Advance that baseline synchronously so an adjacent watcher
    // event cannot turn our own outbound prompt into a one-frame unread badge.
    // Draft ids are not backend session ids; promotion marks the real row read.
    if (!sessions.isPending(sid)) sessions.markRead(sid);
    const sessionState = sessionCache.bySession[sid];
    // `nextLineIndex` is the physical source high-water mark. `lines` is a
    // sparse render cache and can lag it when the backend filters non-rendered
    // records, so lines.length is not a safe send boundary.
    const startLineIndex = sessionState?.nextLineIndex ?? sessionState?.lines.length ?? 0;
    pendId = promptPending.add(sid, {
      text: snapText,
      imageCount: pendingImages.value.length,
      startedAtLineCount: startLineIndex,
      startedAtSessionSize: sessions.byId[sid]?.size ?? 0,
      agent,
      // codex mid-turn = backend routes through turn/steer (injected into the
      // live turn immediately, not queued). Label the bubble honestly.
      ...(agent === "codex" && props.running ? { steered: true } : {}),
    });
    // Give Vue a render turn before provider metadata lookup or network I/O.
    // This makes the full user bubble visible in the same interaction frame;
    // the durable JSONL/rollout record replaces it when it arrives.
    await nextTick();
  }
  const slashCommands = await providerSlashCommandsFor(snapText, sid);
  const providerSlash = isForwardedSlashCommand(snapText, slashCommands);
  let dispatched = false;
  let clearedTextOnDispatch = false;
  let removedImagesOnDispatch: PendingImage[] = [];
  const markDispatched = () => {
    if (dispatched) return;
    dispatched = true;
    if (pendId) promptPending.markDispatched(sid, pendId);
    // The message has left the browser. Reflect that immediately instead of
    // leaving a duplicate copy in the composer while a new Codex thread boots
    // MCP servers. The optimistic user bubble remains visible above.
    clearedTextOnDispatch = drafts.clearIfMatches(sid, snapText);
    removedImagesOnDispatch = imageDrafts.take(sid, snapImageIds);
  };
  try {
    if (draftCwd) {
      // Pending draft path: spawn the session via newSession. Model /
      // permission / effort picks made on the draft's pill row ride along
      // too, so they apply from the very first turn.
      const draftSettings = sessions.pendingDrafts[sid];
      const clientFingerprint = idempotencyFingerprint(JSON.stringify([
        snapText,
        snapImageIds,
        sessions.byId[sid]?.agent ?? "claude",
        draftSettings?.model ?? "",
        draftSettings?.permissionMode ?? "",
        draftSettings?.effort ?? "",
        draftSettings?.serviceTier ?? "",
      ]));
      const clientUuid = sessions.newSessionClientUuid(
        sid,
        clientFingerprint,
        pendId ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const created = await newSession(
        {
          cwd: draftCwd,
          prompt: providerSlash ? snapText : applyThinkingTrigger(snapText),
          clientUuid,
          ...(snapImages.length ? { images: snapImages } : {}),
          ...(slashCommands.length ? { slashCommands } : {}),
          ...(sessions.byId[sid]?.agent ? { agent: sessions.byId[sid]!.agent } : {}),
          ...(draftSettings?.model ? { model: draftSettings.model } : {}),
          ...(draftSettings?.permissionMode ? { permissionMode: draftSettings.permissionMode } : {}),
          ...(draftSettings?.effort ? { effort: draftSettings.effort } : {}),
          ...(draftSettings?.serviceTier !== undefined ? { serviceTier: draftSettings.serviceTier } : {}),
        },
        markDispatched,
      );
      promotePendingDraft(sid, created.sessionId);
    } else {
      await sendPrompt(
        sid,
        providerSlash ? snapText : applyThinkingTrigger(snapText),
        snapImages.length ? snapImages : undefined,
        pendId ?? undefined,
        slashCommands,
        markDispatched,
      );
    }
    // onSent normally calls this synchronously with WebSocket.send(). Keep an
    // idempotent success fallback so a future transport cannot resolve a
    // request without committing the dispatched composer state.
    markDispatched();
    const settledSid = sessions.resolvePromoted(sid);
    if (pendId) promptPending.markAccepted(settledSid, pendId);
  } catch (err) {
    // Before dispatch, the original composer state is still intact. After
    // dispatch it was cleared for responsive feedback, so restore exactly
    // what this attempt removed. restoreBefore preserves any newer draft.
    const settledSid = sessions.resolvePromoted(sid);
    if (dispatched) {
      if (clearedTextOnDispatch) drafts.restoreBefore(settledSid, snapText);
      imageDrafts.restore(settledSid, removedImagesOnDispatch);
    }
    // Drop the optimistic bubble so it doesn't linger pretending success.
    if (pendId) promptPending.remove(settledSid, pendId);
    notifications.pushError(friendlySendError(err), { title: sendErrorTitle(err) });
  }
}

// Desktop-like = either hover-capable OR has a fine pointer. The earlier
// AND-version was too strict — some hybrid laptops (touch screens with a
// connected mouse, certain Chromium/Edge builds, browsing through corporate
// proxies) report only one of the two even when there's clearly a real
// keyboard + mouse. Pure touch phones report neither, so the OR keeps them
// in "Send-button only" mode. Evaluated once at mount; we don't expect users
// to plug in a mouse mid-session.
const isDesktopLike = typeof window !== "undefined"
  && typeof window.matchMedia === "function"
  && (window.matchMedia("(hover: hover)").matches
    || window.matchMedia("(pointer: fine)").matches);

// Desktop + Claude-Code skin → render the unified single-box composer
// (textarea on top, model/approval pills + send in a bottom toolbar) that
// mirrors the real Claude Code input. Everything else — mobile (any skin) and
// the other desktop skins — keeps the WeChat-style row below (v-else).
const isCcDesktop = computed(() => isDesktopViewport.value && prefs.messageDisplayStyle === "claude-code");

function onTextareaKey(e: KeyboardEvent) {
  if (slash.open.value && !e.isComposing) {
    if (e.key === "ArrowDown") { e.preventDefault(); slash.moveDown(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); slash.moveUp(); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); void applySlashAccept(); return; }
    if (e.key === "Escape") { e.preventDefault(); slash.close(); return; }
  }
  // A real character keystroke (not Ctrl/Cmd/Alt shortcut) re-enables the menu
  // after it was suppressed by a paste or closed with Escape. Generic input/
  // keyup/click events must NOT clear suppression, or a pasted path would pop
  // the menu open on the input event that follows the paste.
  if (!e.metaKey && !e.ctrlKey && !e.altKey &&
      (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete")) {
    slash.noteInput();
  }
  if (e.key !== "Enter" || e.isComposing) return;
  // Cmd/Ctrl+Enter = send everywhere (escape hatch on mobile, redundant on desktop).
  if (e.metaKey || e.ctrlKey) {
    e.preventDefault();
    void send();
    return;
  }
  // Plain Enter on desktop: behavior depends on user setting (default: send).
  // Shift+Enter always inserts a newline. Mobile always inserts a newline.
  if (isDesktopLike && !e.shiftKey && ui.enterBehavior === "send") {
    e.preventDefault();
    void send();
  }
}

// Auto-grow the textarea from a single-line baseline up to a cap, so the
// composer stays compact by default and only takes vertical space when the
// user actually types a long prompt. WeChat / Doubao behave the same way.
const TEXTAREA_MAX_PX = 192; // ~8 lines at text-sm
function autoResizeTextarea() {
  const el = textareaRef.value;
  if (!el) return;
  // Reset height before measuring so scrollHeight can shrink as well as grow.
  el.style.height = "auto";
  // Empty textarea: don't trust scrollHeight. After a v-if remount or a
  // session switch, the watcher fires on `nextTick` which doesn't always
  // wait for the browser's layout pass to settle — scrollHeight then
  // returns a value that's effectively 2 rows worth of content + padding,
  // and the textarea gets pinned at 2 rows even though it's empty.
  // The rows="1" attribute paired with height:"auto" already gives the
  // correct 1-row baseline, so explicit measurement is just noise here.
  if (!el.value) return;
  el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_PX) + "px";
}

// Refit on every change that can affect content height: typing into the
// composer, and switching sessions (text snaps to the new session's draft).
watch(
  [text, () => props.sessionId],
  async () => {
    await nextTick();
    autoResizeTextarea();
  },
  { immediate: true },
);

// Auto-focus the composer when switching INTO a session so the user can type
// straight away without an extra click. Desktop/keyboard only — on touch
// devices focusing would pop the on-screen keyboard, which WeChat deliberately
// does NOT do when you open a chat. Skip when nothing is selected.
watch(
  () => props.sessionId,
  async (id) => {
    attachmentTrayOpen.value = false;
    if (!id || !isDesktopLike) return;
    await nextTick();
    textareaRef.value?.focus();
  },
  { immediate: true },
);

onMounted(() => {
  unregisterAppBack = registerAppBackHandler(() => {
    if (slash.open.value) {
      slash.close();
      return true;
    }
    if (attachmentTrayOpen.value) {
      attachmentTrayOpen.value = false;
      return true;
    }
    return false;
  }, APP_BACK_PRIORITY.menu);
  if (typeof window.matchMedia === "function") {
    desktopViewportQuery = window.matchMedia("(min-width: 768px)");
    updateDesktopViewport(desktopViewportQuery);
    desktopViewportQuery.addEventListener("change", updateDesktopViewport);
  }
});
onBeforeUnmount(() => {
  unregisterAppBack?.();
  desktopViewportQuery?.removeEventListener("change", updateDesktopViewport);
  desktopViewportQuery = null;
  stopWechatComposerResize();
});
</script>

<template>
  <div
    class="cw-prompt-input shrink-0 border-t border-[var(--cw-border)]  px-3 pt-2 pb-3"
    :class="{ 'cw-wechat-composer-resizing': wechatResizing }"
    :style="composerStyle"
  >
    <button
      v-if="isWechatComposer"
      type="button"
      class="cw-wechat-resize-handle"
      title="Drag to resize input area"
      aria-label="Resize input area"
      @pointerdown="startWechatComposerResize"
      @dblclick="resetWechatComposerHeight"
    ><span /></button>
    <!-- Desktop's combined picker plus dedicated mobile actions. Splitting the
         mobile inputs lets 相册 and 拍摄 go straight to the requested surface
         instead of Android's generic two-choice intermediary. -->
    <input
      ref="fileInputRef"
      type="file"
      accept="image/*,application/pdf,video/*"
      multiple
      class="hidden"
      @change="onFileInput"
    />
    <input
      ref="galleryInputRef"
      type="file"
      accept="image/*,video/*"
      multiple
      class="hidden"
      @change="onFileInput"
    />
    <input
      ref="cameraInputRef"
      type="file"
      accept="image/*"
      capture="environment"
      class="hidden"
      @change="onFileInput"
    />
    <!-- Keep files separate from camera capture. Videos remain selectable only
         so onFileInput can explain that they are not supported. -->
    <input
      ref="browseInputRef"
      type="file"
      accept="application/pdf,video/*"
      multiple
      class="hidden"
      @change="onFileInput"
    />

    <!-- ===== Desktop · Claude-Code skin: single unified composer box =====
         Textarea on top, a slim toolbar (model/approval pills + attach + send)
         below — one border, mirroring the real Claude Code input. Mobile and
         every other skin fall through to the WeChat-style row (v-else). -->
    <template v-if="isCcDesktop">
      <div v-if="hasPendingImages" class="cw-image-draft-strip flex flex-wrap gap-2 mb-2">
        <div
          v-for="img in pendingImages"
          :key="img.id"
          class="relative group border border-[var(--cw-border)]  rounded overflow-hidden"
          :title="attachmentTitle(img)"
        >
          <button
            v-if="!isPdfDraft(img.mime)"
            type="button"
            class="block cursor-zoom-in"
            :aria-label="`预览 ${img.name ?? '待发送图片'}`"
            @click="previewImage(img)"
          >
            <img :src="img.dataUrl" alt="" class="block h-16 w-16 object-cover" />
          </button>
          <div v-else class="cw-pdf-draft-chip flex items-center gap-1.5 h-16 px-2 max-w-40 text-xs text-[var(--cw-text)]  bg-[var(--cw-panel-2)] ">
            <span aria-hidden="true">📄</span>
            <span class="truncate pr-4">{{ img.name ?? "PDF" }}</span>
          </div>
          <button
            class="cw-image-remove-button absolute top-0 right-0 bg-black/60 text-white text-xs leading-none px-1.5 py-0.5 rounded-bl opacity-80 hover:opacity-100"
            @click.stop="removeImage(img.id)"
            title="Remove"
          >×</button>
        </div>
        <span class="cw-attachment-size-summary self-center text-xs opacity-60 whitespace-nowrap">{{ attachmentSizeSummary }}</span>
        <button
          type="button"
          class="cw-original-mode-toggle self-center text-xs px-2 py-1 rounded border border-[var(--cw-border)]"
          :class="{ 'bg-[var(--cw-accent)] text-[var(--cw-accent-text)]': sendOriginalAttachments }"
          :aria-pressed="sendOriginalAttachments"
          title="Affects photos selected after changing this option"
          @click="sendOriginalAttachments = !sendOriginalAttachments"
        >原图</button>
      </div>
      <SlashCommandMenu
        v-if="slash.open.value"
        :items="slash.items.value"
        :active-index="slash.activeIndex.value"
        @select="(i) => applySlashAccept(i)"
        @hover="(i) => slash.setActive(i)"
      />
      <div class="cw-cc-composer">
        <textarea
          ref="textareaRef"
          v-model="text"
          rows="1"
          name="message"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="sentences"
          spellcheck="true"
          inputmode="text"
          :disabled="isInflightHere"
          class="cw-cc-textarea"
          :placeholder="promptPlaceholder"
          @paste="(e) => { slash.notePaste(); onPaste(e); }"
          @keydown="onTextareaKey"
          @keyup="syncSlash"
          @focus="onTextareaFocus"
          @click="syncSlash"
          @input="syncSlash"
        />
        <div class="cw-cc-toolbar">
          <PillRow :session-id="sessionId" />
          <span class="cw-cc-spacer" />
          <button
            type="button"
            class="cw-cc-tool-btn"
            :disabled="isInflightHere"
            @click="(e) => { openFilePicker(); (e.currentTarget as HTMLElement).blur(); }"
            title="Attach file"
            aria-label="Attach file"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-[18px] h-[18px]">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            class="cw-cc-send"
            :disabled="!canSend || isInflightHere"
            @click="() => void send()"
            :title="sendActionTitle"
            :aria-label="sendActionTitle"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="w-[18px] h-[18px]">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="6 11 12 5 18 11" />
            </svg>
          </button>
        </div>
      </div>
    </template>

    <!-- ===== Mobile (any skin) + other desktop skins: WeChat-style row ===== -->
    <template v-else>
    <!-- Pill row: model / permissionMode / interrupt. Rendered for drafts
         too — picks are stashed on the pending draft and ride along with
         the first newSession call (interrupt pill hides itself). -->
    <PillRow :session-id="sessionId" />
    <div v-if="hasPendingImages" class="cw-image-draft-strip flex flex-wrap gap-2 mb-2">
      <div
        v-for="img in pendingImages"
        :key="img.id"
        class="relative group border border-[var(--cw-border)]  rounded overflow-hidden"
        :title="attachmentTitle(img)"
      >
        <button
          v-if="!isPdfDraft(img.mime)"
          type="button"
          class="block cursor-zoom-in"
          :aria-label="`预览 ${img.name ?? '待发送图片'}`"
          @click="previewImage(img)"
        >
          <img :src="img.dataUrl" alt="" class="block h-16 w-16 object-cover" />
        </button>
        <div v-else class="cw-pdf-draft-chip flex items-center gap-1.5 h-16 px-2 max-w-40 text-xs text-[var(--cw-text)]  bg-[var(--cw-panel-2)] ">
          <span aria-hidden="true">📄</span>
          <span class="truncate pr-4">{{ img.name ?? "PDF" }}</span>
        </div>
        <button
          class="cw-image-remove-button absolute top-0 right-0 bg-black/60 text-white text-xs leading-none px-1.5 py-0.5 rounded-bl opacity-80 hover:opacity-100"
          @click.stop="removeImage(img.id)"
          title="Remove"
        >×</button>
      </div>
      <span class="cw-attachment-size-summary self-center text-xs opacity-60 whitespace-nowrap">{{ attachmentSizeSummary }}</span>
    </div>
    <SlashCommandMenu
      v-if="slash.open.value"
      :items="slash.items.value"
      :active-index="slash.activeIndex.value"
      @select="(i) => applySlashAccept(i)"
      @hover="(i) => slash.setActive(i)"
    />
    <div class="cw-composer-row flex items-end gap-2">
      <!-- Attachment access keeps a permanent thumb-reachable slot. It never
           competes with Send, so text, a captured photo, or existing drafts do
           not prevent the user from adding another item. -->
      <button
        type="button"
        class="cw-attach-button shrink-0 w-9 h-9 rounded-full border border-[var(--cw-border)]  bg-transparent opacity-80 hover:opacity-100 hover:bg-[var(--cw-panel-2)]  active:opacity-75  transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-[var(--cw-text)] "
        :class="{ 'cw-attach-button-open': attachmentTrayOpen }"
        :disabled="isInflightHere"
        :aria-expanded="attachmentTrayOpen"
        aria-controls="cw-attachment-tray"
        @click="(e) => { toggleAttachmentTray(); (e.currentTarget as HTMLElement).blur(); }"
        :title="attachmentButtonLabel"
        :aria-label="attachmentButtonLabel"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      <!-- Middle: textarea pinned to the control baseline. Single-line by
           default; grows from there as you type, capped at max-h-48 (~8 lines). -->
      <textarea
        ref="textareaRef"
        v-model="text"
        rows="1"
        name="message"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="sentences"
        spellcheck="true"
        inputmode="text"
        :disabled="isInflightHere"
        class="cw-composer-textarea min-w-0 flex-1 resize-none overflow-y-auto rounded-lg bg-[var(--cw-panel-2)]  border-0 px-3 py-2 text-sm leading-5 max-h-48 focus:outline-none focus:ring-2 focus:ring-[var(--cw-focus-ring)]"
        :placeholder="promptPlaceholder"
        @paste="(e) => { slash.notePaste(); onPaste(e); }"
        @keydown="onTextareaKey"
        @keyup="syncSlash"
        @focus="onTextareaFocus"
        @click="syncSlash"
        @input="syncSlash"
      />

      <!-- Send owns its own right-side slot and appears only with sendable
           content; the attachment control remains available beside it. -->
      <button
        v-if="showSendButton"
        type="button"
        @click="() => void send()"
        :disabled="!canSend || isInflightHere"
        class="cw-send-button shrink-0 h-9 px-4 rounded-lg bg-[var(--cw-accent)] text-[var(--cw-accent-text)] text-sm font-semibold hover:opacity-100 active:scale-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
      >{{ sendLabel }}</button>
    </div>
    <div
      v-if="!isDesktopViewport && attachmentTrayOpen"
      id="cw-attachment-tray"
      class="cw-attachment-tray"
      aria-label="附件"
    >
      <div class="cw-attachment-action-group" role="group" aria-label="相册选项">
        <button type="button" class="cw-attachment-action" @click="openGalleryPicker">
          <span class="cw-attachment-action-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3.5" y="4" width="17" height="16" rx="2" />
              <circle cx="9" cy="9" r="1.5" />
              <path d="m5.5 17 4.2-4.2 3.1 3 2.2-2.2 3.5 3.4" />
            </svg>
          </span>
          <span>相册</span>
        </button>
        <label class="cw-gallery-original-option" title="不压缩之后从相册选择的照片">
          <input v-model="sendOriginalAttachments" type="checkbox" />
          <span>原图</span>
        </label>
      </div>
      <button type="button" class="cw-attachment-action" @click="openCameraPicker">
        <span class="cw-attachment-action-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8.5 6 10 4h4l1.5 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
            <circle cx="12" cy="12.5" r="4" />
          </svg>
        </span>
        <span>拍摄</span>
      </button>
      <button type="button" class="cw-attachment-action" @click="openFileBrowser">
        <span class="cw-attachment-action-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 3.5h8l4 4V20H6z" />
            <path d="M14 3.5V8h4M9 12h6M9 15.5h6" />
          </svg>
        </span>
        <span>文件</span>
      </button>
    </div>
    </template>
  </div>
</template>
