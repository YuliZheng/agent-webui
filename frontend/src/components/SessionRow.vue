<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from "vue";
import { useUiStore } from "../stores/ui.js";
import { useSessionsStore } from "../stores/sessions.js";
import { usePrefsStore } from "../stores/prefs.js";
import { useNotificationsStore } from "../stores/notifications.js";
import { useDraftsStore } from "../stores/drafts.js";
import { useImageDraftsStore } from "../stores/image-drafts.js";
import { usePromptPendingStore } from "../stores/prompt-pending.js";
import { useBackgroundTasksStore } from "../stores/background-tasks.js";
import { useLiveStore } from "../stores/live.js";
import { displayCwd } from "../util/cwd-display.js";
import { avatarGradient, avatarText, gradientForIndex, paletteColor } from "../util/avatar.js";
import { imTime } from "../util/time.js";
import { nowMs, formatElapsed } from "../util/now-tick.js";
import { currentTurnBackgroundTasks } from "../util/runtime-work.js";
import { effectiveSessionActivityIso } from "../util/session-recency.js";
import { isReadOnlySubagentSession } from "../util/session-access.js";
import { latestSidebarPendingPrompt } from "../util/pending-prompt-reconciliation.js";
import { APP_BACK_PRIORITY, registerAppBackHandler } from "../util/app-back.js";
import { setPwaLayerActive } from "../util/pwa-history.js";
import { retitleSession, setSessionTitle } from "../api/sessions.js";

// Module-scoped — only one row across the whole sidebar can be in the
// swiped-open state at a time. Opening a different row collapses any
// previously-open one (matches WeChat behavior). null = nothing open.
const openSwipedRowId = ref<string | null>(null);

const props = withDefaults(
  defineProps<{ id: string; depth?: number; hideCwd?: boolean }>(),
  // Default to single-line rows everywhere — cwd-auto-groups already
  // surface the cwd in the group header, and pinned/manual groups are
  // user-curated so the user knows what each row is. The cwd is still
  // discoverable via the row's hover tooltip below.
  { depth: 0, hideCwd: true },
);
const ui = useUiStore();
const sessions = useSessionsStore();
const prefs = usePrefsStore();
const notifications = useNotificationsStore();
const drafts = useDraftsStore();
const imageDrafts = useImageDraftsStore();
const promptPending = usePromptPendingStore();
const backgroundTasks = useBackgroundTasksStore();
const live = useLiveStore();
const item = computed(() => sessions.byId[props.id]);
const isReadOnlySubagent = computed(() => isReadOnlySubagentSession(item.value));
// Count of running background tasks (subagents / workflows / background
// shells) for this session — small ⟳N badge next to the status dot.
const bgRunning = computed(() => currentTurnBackgroundTasks(
  backgroundTasks.running(props.id),
  item.value?.agent === "codex" ? item.value.lastBoundaryAt : undefined,
).length);

const status = computed(() => sessions.statusBySession[props.id] ?? null);
const capacityRetry = computed(() => sessions.capacityRetryBySession[props.id] ?? null);
const capacityRetryWaitSeconds = computed(() => {
  if (!capacityRetry.value) return 0;
  return Math.max(0, Math.ceil(
    (Date.parse(capacityRetry.value.retryAt) - nowMs.value) / 1_000,
  ));
});
const selected = computed(() => ui.selectedSessionId === props.id);
const cwd = computed(() => displayCwd(item.value?.cwd, ui.home));
const cwdRaw = computed(() => item.value?.cwd ?? "");
const shortId = computed(() => props.id.slice(0, 8));
const isDraft = computed(() => sessions.isPending(props.id));
const title = computed(() => item.value?.title ?? null);
const titleIsManual = computed(() => item.value?.titleSource === "manual");
// Avatar visuals — HUE from cwd (same dir → same color family, including
// forks), with subtle per-session lightness variation so siblings still
// read as distinct rows. Glyph is one character: title's leading char if
// titled, else the cwd basename's first letter.
// Color by the recency-aware cwd→palette assignment so recently-active
// distinct directories never share a color (same dir still shares). Falls
// back to the plain hash gradient for pending drafts not yet in the list.
const cwdColorIndex = computed(() =>
  cwdRaw.value ? sessions.cwdColorIndex.get(cwdRaw.value) : undefined,
);
const avatarBg = computed(() =>
  cwdColorIndex.value === undefined
    ? avatarGradient({ cwd: cwdRaw.value, id: props.id })
    : gradientForIndex(cwdColorIndex.value, props.id),
);
// Tint the cwd path text to match the avatar so the path↔avatar link is
// obvious and same-dir rows read as a color group. color-mix blends the
// palette hue with the inherited (theme-adaptive) text color so it stays
// legible in both light and dark mode. Undefined for drafts not in the map.
const pathTint = computed(() => {
  if (cwdColorIndex.value === undefined) return undefined;
  return `color-mix(in srgb, ${paletteColor(cwdColorIndex.value)} 55%, currentColor)`;
});
// Avatar glyph: prefer the auto-titler's emoji when present (it's chosen
// to evoke the topic and is far more distinctive at a glance than a first
// letter). Falls back to the existing first-letter-of-title scheme for
// rows without an emoji (manual-only renames, brand-new untitled rows).
const titleEmoji = computed(() => item.value?.titleEmoji ?? null);
const avatarIsEmoji = computed(() => !!titleEmoji.value);
const avatarChar = computed(() => titleEmoji.value || avatarText({
  title: title.value,
  cwd: cwdRaw.value,
  id: props.id,
}));
// Draft edits and optimistic sends are user-visible activity immediately.
// Otherwise prefer backend lastTurnAt; file mtime is only the compatibility
// fallback because sidechain writes can touch it without visible activity.
const lastActivity = computed(() => {
  return effectiveSessionActivityIso(
    item.value,
    drafts.editedAt(props.id),
    promptPending.latestStartedAt(props.id),
  );
});
const timeLabel = computed(() => (lastActivity.value ? imTime(lastActivity.value) : ""));
// Last message preview: shown as the row's secondary line. If the backend
// hasn't populated it (older list payload), fall back to cwd display so the
// row still has useful context.
const preview = computed(() => item.value?.preview ?? null);

// "Live" preview that mirrors whatever the user would see at the bottom of
// the chat, WeChat-style. Priority order, highest first:
//   1. Draft text the user is composing  →  "[Draft] xxx"
//   2. Pending images attached to draft  →  "📷 N images attached"
//   3. Capacity retry in progress         →  "Model busy · retry N/M"
//   4. Optimistic prompt (just clicked Send, jsonl not yet observed)
//   5. Backend's stored latest visible message (user or assistant)
//   6. Agent is mid-turn, but no visible message has landed yet
type PreviewKind = "draft" | "images" | "retry" | "pending" | "thinking" | "preview" | "none";
interface LivePreview { text: string; kind: PreviewKind }

const livePreview = computed<LivePreview>(() => {
  const draftText = drafts.text(props.id).trim();
  if (draftText) return { text: `[Draft] ${draftText}`, kind: "draft" };

  const imgCount = imageDrafts.count(props.id);
  if (imgCount > 0) {
    return { text: `📷 ${imgCount} image${imgCount === 1 ? "" : "s"} attached`, kind: "images" };
  }

  if (capacityRetry.value) {
    const wait = capacityRetryWaitSeconds.value > 0
      ? ` · next in ${capacityRetryWaitSeconds.value}s`
      : "";
    return {
      text: `Model busy · retry ${capacityRetry.value.attempt}/${capacityRetry.value.maxAttempts}${wait}`,
      kind: "retry",
    };
  }

  const pp = latestSidebarPendingPrompt(promptPending.pending(props.id), {
    backendPreview: preview.value,
    now: nowMs.value,
    sessionSize: item.value?.size ?? 0,
  });
  if (pp?.text) {
    return { text: pp.text, kind: "pending" };
  }

  if (isRunning.value) {
    // Anchor on lastBoundaryAt — the moment THIS turn started (user message
    // arrived). Mid-turn assistant chunks and tool_use writes don't update
    // it, so the counter measures TOTAL time the current turn has been
    // running, not "time since last write". Matches the in-message thinking
    // indicator. Falls back to file mtime if backend hasn't sent a boundary
    // yet (very brief window after page load).
    const anchorStr = item.value?.lastBoundaryAt || item.value?.mtime;
    const anchor = anchorStr ? Date.parse(anchorStr) : NaN;
    const elapsed = Number.isFinite(anchor) ? formatElapsed(nowMs.value - anchor) : "";
    // /compact runs silently (no jsonl writes) — without its own label the
    // row says "thinking" for minutes with nothing visibly happening.
    const verb = sessions.compactingBySession[props.id]
      ? "🗜 Compacting context…"
      : (item.value?.previewRole === "assistant" ? preview.value : "")
        || live.turnProgress[props.id]
        || `${item.value?.agent === "codex" ? "Codex is starting work…" : "Claude is thinking…"}`;
    return {
      text: elapsed ? `${verb} ${elapsed}` : verb,
      kind: "thinking",
    };
  }

  if (preview.value) return { text: preview.value, kind: "preview" };

  return { text: "", kind: "none" };
});
const isRunning = computed(() =>
  status.value === "running" ||
  // Match MainPane's dot (isWorking || isCompacting): during a /compact the
  // jsonl is silent and the parser drives status via markCompacting. Normally
  // markResponding(true) already holds status==="running", so this only adds
  // coverage for event-order / foreign-attach edge cases, never removes it.
  sessions.compactingBySession[props.id] === true,
);
const isFailed = computed(
  () => status.value === "failed",
);

const pinned = computed(() => prefs.isPinnedSession(props.id));
const isHidden = computed(() => prefs.hidden.includes(props.id));
const hasDraft = computed(() =>
  drafts.text(props.id).trim().length > 0 || imageDrafts.count(props.id) > 0,
);
const unread = computed(() => sessions.unreadBySession[props.id] ?? 0);
const groupNames = computed(() => prefs.groupNames());
const currentGroup = computed(() => prefs.groupOf(props.id));

const editing = ref(false);
const draftTitle = ref("");
const titleInput = ref<HTMLInputElement | null>(null);
const autoTitling = ref(false);
// Combined "is this row currently being retitled" — true if the user
// clicked Auto on this row (local flag) OR the backend broadcast that
// periodic auto-retitle started for this session (store flag). Either
// way the title slot shows the spinner.
const showRetitling = computed(() => autoTitling.value || sessions.isRetitling(props.id));
// Set when the user clicks the Auto button so the impending blur on the
// rename input doesn't fire commitRename and overwrite the title we're
// about to receive from the backend.
let suppressBlurCommit = false;

// Action menu state. Opened by either: long-press on touch (anchored at
// touch point) or right-click on desktop (anchored at mouse cursor).
// Closes on outside-click or after any action.
const menuOpen = ref(false);
watch([menuOpen, editing], ([menu, rename]) => {
  setPwaLayerActive(`session-row:${props.id}`, menu || rename, ui.selectedSessionId);
});
const menuStyle = ref<{ top: string; left: string }>({ top: "0", left: "0" });

function pick() { ui.select(props.id); }

// Long-press → open the ⋯ menu, since the menu trigger button is hidden on
// touch devices (hover-revealed buttons don't make sense without a cursor,
// and they were stealing horizontal space and pushing right-side content
// off-screen on narrow phones). 500 ms feels right — same as iOS native.
const LONG_PRESS_MS = 500;
const LONG_PRESS_CANCEL_PX = 10;
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let pressStartX = 0;
let pressStartY = 0;
let pressedFiredMenu = false;

function onPressStart(e: PointerEvent) {
  if (e.pointerType !== "touch") return;
  pressedFiredMenu = false;
  pressStartX = e.clientX;
  pressStartY = e.clientY;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    pressedFiredMenu = true;
    // Anchor the menu near the touch point rather than relative to a button.
    const menuWidth = 180;
    const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, pressStartX - menuWidth / 2));
    const top = Math.min(window.innerHeight - 220, pressStartY + 8);
    menuStyle.value = { top: `${top}px`, left: `${left}px` };
    menuOpen.value = true;
    setTimeout(() => document.addEventListener("click", onDocClick), 0);
  }, LONG_PRESS_MS);
}

function onPressMove(e: PointerEvent) {
  if (!pressTimer) return;
  const dx = Math.abs(e.clientX - pressStartX);
  const dy = Math.abs(e.clientY - pressStartY);
  if (dx > LONG_PRESS_CANCEL_PX || dy > LONG_PRESS_CANCEL_PX) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}

function onPressEnd() {
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
}

// ─── WeChat-style left-swipe to reveal Rename / Pin / Delete actions ───
// Touch-only — desktop uses right-click context menu (handled separately).
// The swipe and long-press systems share pointerdown/move/up — long-press
// auto-cancels at 10px movement, so it never collides with a real swipe.
//
// Smoothness: during finger-tracking we write the row's transform DIRECTLY
// to the DOM via the rowEl ref, NOT through a Vue reactive offset. Going
// through Vue would re-render the whole SessionRow on every pointermove
// (this component has lots of computed props for status/preview/etc), which
// is the dominant source of "feels janky on touch". Reactive state (the
// open/closed bit, the tray's pointer-events flag) is only updated at
// snap-time so the rest of the UI stays consistent without paying the
// per-frame re-render cost.
const ACTIONS_WIDTH_PX = 210; // 3 buttons × 70 px
// Wait until movement clearly exceeds noise before deciding axis. Too small
// (6 px) and a fast vertical scroll's tiny horizontal jitter at the start
// of the gesture gets mis-locked as a horizontal swipe and the action tray
// pops open mid-scroll. 10 px gives the user one or two more samples to
// settle into the real direction.
const SWIPE_AXIS_LOCK_PX = 10;
// Horizontal must DOMINATE vertical (≥ 2×) to commit to swipe. A
// fingerprint moving at 30°-from-vertical is almost certainly a scroll
// gesture with some sideways drift, not a deliberate left swipe.
const SWIPE_AXIS_HORIZONTAL_RATIO = 2;
const SWIPE_SNAP_THRESHOLD = 70; // open if dragged past one button width
const swipeOpen = computed(() => openSwipedRowId.value === props.id);
const trayInteractive = ref(false); // toggles pointer-events on the action tray
// The tray itself is mounted (display:flex) only when actively swiping or
// snapped open. Always-painted means iOS Safari occasionally bleeds the
// tray's color through the row's solid bg during fast vertical scroll
// (compositor tile reuse glitch). v-show keeps the DOM element around
// (cheap to re-show on next swipe) but takes it out of the paint path
// when idle.
const trayVisible = ref(false);
// 220ms matches the snap-close transition; we keep the tray visible for
// the duration of the slide so the buttons don't pop out of existence
// before the row finishes covering them.
const TRAY_HIDE_DELAY_MS = 230;
let trayHideTimer: ReturnType<typeof setTimeout> | null = null;
function clearTrayHideTimer() {
  if (trayHideTimer) { clearTimeout(trayHideTimer); trayHideTimer = null; }
}
const rowEl = ref<HTMLElement | null>(null);
// Wraps both the row AND the action tray (which sit as siblings). The
// outside-tap auto-close has to check this wrapper, not just rowEl, or
// taps on the tray buttons (which are NOT inside rowEl) would be
// treated as outside-the-row and snap the tray shut before the click
// handler could commit.
const swipeWrapperEl = ref<HTMLElement | null>(null);
let currentSwipePx = 0;
let swipeStartX = 0;
let swipeStartY = 0;
let swipeStartOffset = 0;
let swipeAxis: "h" | "v" | "?" | "ignored" = "ignored";
let swipeCaptured = false;
let swipePointerId = -1;
// Suppress click after a horizontal swipe so the row doesn't navigate into
// the chat when the user just opened/closed the actions tray.
let swipeSuppressClick = false;

function setRowTransform(px: number, animate: boolean): void {
  const el = rowEl.value;
  if (!el) return;
  // iOS-style ease-out: fast start, gentle settle.
  el.style.transition = animate ? "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "none";
  // will-change only while the row is off-zero. Permanent will-change
  // forces a separate compositor layer for every row in the sidebar,
  // which on iOS Safari leads to occasional paint glitches during fast
  // vertical scroll (the tile cache for the layer lags the actual
  // scroll position). Setting back to "auto" when settled lets the
  // browser drop the layer.
  if (px === 0) {
    el.style.transform = "";
    el.style.willChange = "auto";
  } else {
    el.style.transform = `translate3d(${px}px, 0, 0)`;
    el.style.willChange = "transform";
  }
  currentSwipePx = px;
}

function snapClosed(animate: boolean): void {
  setRowTransform(0, animate);
  trayInteractive.value = false;
  if (openSwipedRowId.value === props.id) openSwipedRowId.value = null;
  // Keep the tray painted for one transition's worth so the row's slide
  // doesn't reveal an empty void behind it; then unmount.
  clearTrayHideTimer();
  if (animate) {
    trayHideTimer = setTimeout(() => { trayVisible.value = false; trayHideTimer = null; }, TRAY_HIDE_DELAY_MS);
  } else {
    trayVisible.value = false;
  }
}
function snapOpen(animate: boolean): void {
  clearTrayHideTimer();
  trayVisible.value = true;
  setRowTransform(-ACTIONS_WIDTH_PX, animate);
  trayInteractive.value = true;
  openSwipedRowId.value = props.id;
}

// If another row opens (or some external code clears openSwipedRowId) while
// we're showing the tray, animate ours closed too. Skip when mid-drag so we
// don't fight the user's finger.
watch(openSwipedRowId, (id) => {
  if (id !== props.id && currentSwipePx !== 0 && !swipeCaptured) {
    setRowTransform(0, true);
    trayInteractive.value = false;
    clearTrayHideTimer();
    trayHideTimer = setTimeout(() => { trayVisible.value = false; trayHideTimer = null; }, TRAY_HIDE_DELAY_MS);
  }
});

// Tap-outside auto-close. Mounts a one-shot pointerdown listener whenever
// the tray is open; if the next pointerdown lands outside this row, snap
// closed. Removes itself on close so we don't accumulate listeners.
function onOutsideTap(e: PointerEvent) {
  // Check the SWIPE WRAPPER (row + tray), not just rowEl — the action
  // tray buttons are siblings of rowEl, so a tap on them would have
  // looked "outside" and immediately closed the tray, eating the click
  // before swipeAction* could run.
  if (swipeWrapperEl.value?.contains(e.target as Node)) return;
  snapClosed(true);
}
watch(swipeOpen, (open) => {
  if (open) {
    // setTimeout 0 so the pointerdown that opened us doesn't immediately
    // trigger this and close us back.
    setTimeout(() => document.addEventListener("pointerdown", onOutsideTap), 0);
  } else {
    document.removeEventListener("pointerdown", onOutsideTap);
  }
});

function onSwipeStart(e: PointerEvent) {
  if (e.pointerType === "mouse" || editing.value) {
    swipeAxis = "ignored";
    return;
  }
  swipeStartX = e.clientX;
  swipeStartY = e.clientY;
  swipeStartOffset = swipeOpen.value ? -ACTIONS_WIDTH_PX : 0;
  swipeAxis = "?";
  swipeCaptured = false;
  swipePointerId = e.pointerId;
}
function onSwipeMove(e: PointerEvent) {
  if (swipeAxis === "ignored") return;
  if (e.pointerId !== swipePointerId) return;
  const dx = e.clientX - swipeStartX;
  const dy = e.clientY - swipeStartY;
  if (swipeAxis === "?") {
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (adx < SWIPE_AXIS_LOCK_PX && ady < SWIPE_AXIS_LOCK_PX) return;
    // Lock to horizontal only when motion is decisively horizontal —
    // otherwise treat as vertical so a scroll gesture's small sideways
    // jitter doesn't accidentally pop open the action tray.
    swipeAxis = adx > ady * SWIPE_AXIS_HORIZONTAL_RATIO ? "h" : "v";
  }
  if (swipeAxis !== "h") return;
  if (!swipeCaptured) {
    swipeCaptured = true;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    // Cancel long-press timer too — we've committed to a swipe.
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    // Reveal the tray for the duration of the gesture. Skipping this when
    // the row was already open is fine — trayVisible was true then anyway.
    clearTrayHideTimer();
    trayVisible.value = true;
  }
  e.preventDefault();
  let next = swipeStartOffset + dx;
  // Clamp with rubber-band resistance past the edges.
  if (next > 0) next = next * 0.25;
  if (next < -ACTIONS_WIDTH_PX) next = -ACTIONS_WIDTH_PX - (-(next + ACTIONS_WIDTH_PX) * 0.25);
  next = Math.max(-ACTIONS_WIDTH_PX * 1.15, Math.min(0, next));
  // Direct DOM write — no Vue reactivity per frame.
  setRowTransform(next, false);
}
function onSwipeEnd(e: PointerEvent) {
  if (swipeAxis === "ignored") return;
  if (e.pointerId !== swipePointerId) return;
  if (swipeCaptured) {
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    swipeSuppressClick = true;
    if (currentSwipePx < -SWIPE_SNAP_THRESHOLD) snapOpen(true);
    else snapClosed(true);
  }
  swipeCaptured = false;
  swipeAxis = "?";
  swipePointerId = -1;
}

function onContextMenu(e: MouseEvent) {
  // Right-click on desktop: open the same menu the long-press uses on
  // touch. preventDefault stops the browser's native menu.
  e.preventDefault();
  // Anchor menu near the click point, clamped to viewport.
  const menuWidth = 180;
  const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, e.clientX));
  const top = Math.min(window.innerHeight - 220, e.clientY);
  menuStyle.value = { top: `${top}px`, left: `${left}px` };
  menuOpen.value = true;
  setTimeout(() => document.addEventListener("click", onDocClick), 0);
}

function onRowClick(e: MouseEvent) {
  // Suppress the click that fires after a long-press opened the menu —
  // otherwise tapping then releasing also navigates into the chat.
  if (pressedFiredMenu) {
    e.preventDefault();
    e.stopPropagation();
    pressedFiredMenu = false;
    return;
  }
  // Suppress the click that fires immediately after a horizontal swipe
  // gesture concluded — the user was dragging the row, not selecting it.
  if (swipeSuppressClick) {
    e.preventDefault();
    e.stopPropagation();
    swipeSuppressClick = false;
    return;
  }
  // If the actions tray is open, a tap on the row body just closes it
  // (matches WeChat). Don't navigate.
  if (swipeOpen.value) {
    e.preventDefault();
    e.stopPropagation();
    snapClosed(true);
    return;
  }
  pick();
}

// Action handlers wired to the swipe-revealed buttons. All snap the tray
// closed before/after performing the action so the row returns to its
// neutral state.
async function swipeActionRename() {
  snapClosed(true);
  await startRename();
}
function swipeActionTogglePin() {
  if (pinned.value) prefs.unpin({ kind: "session", id: props.id });
  else prefs.pin({ kind: "session", id: props.id });
  snapClosed(true);
}
// Two-tap delete confirm — first tap arms the button (label flips to
// "Confirm?", auto-disarms after 3 s); second tap commits. Avoids
// window.confirm() entirely, which iOS Edge (and other PWA-context
// browsers) sometimes silently suppresses, making the delete swipe
// look broken even though the handler fired.
const deleteArmed = ref(false);
let deleteArmTimer: ReturnType<typeof setTimeout> | null = null;
function disarmDelete() {
  deleteArmed.value = false;
  if (deleteArmTimer) { clearTimeout(deleteArmTimer); deleteArmTimer = null; }
}
// Disarm whenever the swipe tray closes — re-opening should always start
// from the safe "tap once to arm" state, never with the trigger already
// hot from a previous interaction.
watch(swipeOpen, (open) => { if (!open) disarmDelete(); });

async function swipeActionDelete() {
  if (!deleteArmed.value) {
    deleteArmed.value = true;
    if (deleteArmTimer) clearTimeout(deleteArmTimer);
    deleteArmTimer = setTimeout(() => disarmDelete(), 3000);
    return;
  }
  // Armed — commit. Soft-delete: just hide from the sidebar (localStorage
  // pref write, no network round trip — feels instant). The actual jsonl
  // file gets removed via Settings → "Delete all hidden", which batches
  // the real backend unlinks. WeChat-style: list-level "delete" is a
  // soft-archive; permanent removal lives behind a separate gate.
  // Pending drafts have no jsonl — drop them outright instead of hiding.
  disarmDelete();
  if (sessions.isPending(props.id)) {
    if (ui.selectedSessionId === props.id) ui.select(null);
    sessions.dropPending(props.id);
  } else {
    prefs.hide(props.id);
  }
  snapClosed(false);
}
function togglePin() {
  if (pinned.value) prefs.unpin({ kind: "session", id: props.id });
  else prefs.pin({ kind: "session", id: props.id });
  closeMenu();
}
// One-click "new chat here": create the same empty Codex draft as the
// regular new-session flow, using this row's cwd and manual group (if any).
// The actual Codex session is spawned only when the user sends a first
// message, so the conversation stays genuinely blank until then.
function newChatHere() {
  closeMenu();
  const cwd = item.value?.cwd;
  if (!cwd) return;
  const group = prefs.groupOf(props.id);
  const draftId = sessions.createPending(cwd, "codex");
  if (group) prefs.moveToGroup(draftId, group);
  ui.select(draftId);
}
function toggleHide() {
  // Drafts have no jsonl to hide/unhide — "Hide" just deletes them.
  if (sessions.isPending(props.id)) {
    if (ui.selectedSessionId === props.id) ui.select(null);
    sessions.dropPending(props.id);
    closeMenu();
    return;
  }
  if (isHidden.value) prefs.unhide(props.id);
  else prefs.hide(props.id);
  closeMenu();
}
function onGroupChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  prefs.moveToGroup(props.id, v === "" ? null : v);
}

function closeMenu() {
  menuOpen.value = false;
  document.removeEventListener("click", onDocClick);
}
function onDocClick() { closeMenu(); }
const unregisterAppBack = registerAppBackHandler(() => {
  if (menuOpen.value) {
    closeMenu();
    return true;
  }
  if (editing.value) {
    cancelRename();
    return true;
  }
  return false;
}, APP_BACK_PRIORITY.menu);

onBeforeUnmount(() => {
  unregisterAppBack();
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("pointerdown", onOutsideTap);
  clearTrayHideTimer();
});

async function startRename() {
  draftTitle.value = [
    title.value ?? "",
    titleEmoji.value ?? "",
  ].filter(Boolean).join(" ");
  editing.value = true;
  await nextTick();
  titleInput.value?.focus();
  titleInput.value?.select();
}

function cancelRename() {
  editing.value = false;
  draftTitle.value = "";
}

async function commitRename() {
  if (suppressBlurCommit) { suppressBlurCommit = false; return; }
  const next = draftTitle.value.trim();
  editing.value = false;
  const current = [title.value ?? "", titleEmoji.value ?? ""].filter(Boolean).join(" ");
  if (!next || next === current) return;
  try {
    const r = await setSessionTitle(props.id, next);
    sessions.setTitle(props.id, r.title, r.titleSource, r.emoji);
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Rename failed" });
  }
}

// "Auto" button next to the rename input. Re-runs the auto-titler for this
// session and clears the manual lock so periodic re-titling kicks back in.
// Closes the rename UI immediately — backend pushes the new title via the
// session-renamed event, which updates the row in place.
async function autoRetitleHere() {
  if (autoTitling.value) return;
  suppressBlurCommit = true;
  autoTitling.value = true;
  editing.value = false;
  try {
    const r = await retitleSession(props.id);
    if (r.title) sessions.setTitle(props.id, r.title, r.titleSource, r.emoji);
  } catch (err) {
    notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Auto-title failed" });
  } finally {
    autoTitling.value = false;
  }
}

function onTitleKey(e: KeyboardEvent) {
  if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
  else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
}
</script>

<template>
  <!-- Swipe wrapper. The row inside slides left on touch to reveal the
       action tray (Rename / Pin / Delete). The wrapper itself has overflow
       hidden so the tray stays clipped to the row's vertical bounds.
       touch-pan-y lets the parent scroller still handle vertical scroll;
       horizontal pans are intercepted by our pointer handlers via the
       direction-lock heuristic. -->
  <div ref="swipeWrapperEl" class="cw-session-row-wrap relative overflow-hidden touch-pan-y" :data-session-id="id">
    <!-- Action tray (sits underneath the row). Buttons are 70 px each ×
         3 = 210 px total. Always rendered so the row's transform reveals
         them; pointer-events disabled while the row is closed so they
         don't accidentally catch taps in the right margin of a vertical
         scroll. -->
    <div
      v-show="trayVisible"
      class="absolute inset-y-0 right-0 flex items-stretch select-none"
      :style="{ width: '210px', pointerEvents: trayInteractive ? 'auto' : 'none' }"
      aria-hidden="true"
    >
      <!-- WeChat-style two-tap confirm.
           Smoothness notes:
           - Single explicit `transition: width …` (no transition-all) so
             only ONE property animates — flex layout reflows are the
             noisy ones; opacity is on its own faster track.
           - iOS-standard spring easing cubic-bezier(0.32, 0.72, 0, 1)
             which both Apple system animations and recent Material
             "emphasized-decelerate" use. Reads as "fast lift-off,
             slow settle".
           - Constant flex-direction (always col layout) and constant
             font-size — discrete property changes (flex-direction,
             font-size) used to snap mid-tween and made it look chunky.
           - Delete grows via flex-grow only (idle: flex-grow:0 +
             w-[70px]; armed: flex-grow:1 + w-0) so the layout solver
             distributes a single "remaining space" delta instead of
             racing one width-shrink against another width-grow. -->
      <button
        type="button"
        class="overflow-hidden flex flex-col items-center justify-center gap-1 bg-[var(--cw-accent)] text-[var(--cw-accent-text)] text-[11px] font-medium active:brightness-95 [transition:width_280ms_cubic-bezier(0.32,0.72,0,1),opacity_180ms_ease-out]"
        :class="deleteArmed ? 'w-0 opacity-0 pointer-events-none' : 'w-[70px]'"
        @click.stop="swipeActionRename"
        title="Rename"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 shrink-0">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
        <span class="whitespace-nowrap">Rename</span>
      </button>
      <button
        type="button"
        class="overflow-hidden flex flex-col items-center justify-center gap-1 bg-[var(--cw-warning)] text-[var(--cw-accent-text)] text-[11px] font-medium active:brightness-95 [transition:width_280ms_cubic-bezier(0.32,0.72,0,1),opacity_180ms_ease-out]"
        :class="deleteArmed ? 'w-0 opacity-0 pointer-events-none' : 'w-[70px]'"
        @click.stop="swipeActionTogglePin"
        :title="pinned ? 'Unpin' : 'Pin'"
      >
        <span class="text-base leading-none shrink-0">{{ pinned ? '☆' : '★' }}</span>
        <span class="whitespace-nowrap">{{ pinned ? 'Unpin' : 'Pin' }}</span>
      </button>
      <!-- Centered content (icon stacked above label, like Rename / Pin)
           so it fits the 70 px idle button without clipping AND sits in
           the visual center of the 210 px armed button. The right edge
           of the button is geometrically anchored at the tray's right
           edge — flex-grow only eats the freed space from Rename + Pin
           shrinking, so the right edge can't move. The centered content
           does drift leftward as the button widens; that's WeChat's
           actual behavior too (the label "删除" recenters in the wider
           button). -->
      <button
        type="button"
        class="overflow-hidden flex flex-col items-center justify-center gap-1 bg-[var(--cw-danger)] text-[var(--cw-accent-text)] text-[11px] font-medium active:brightness-95 [transition:flex-grow_280ms_cubic-bezier(0.32,0.72,0,1)]"
        :class="deleteArmed ? 'grow w-0' : 'grow-0 w-[70px]'"
        @click.stop="swipeActionDelete"
        :title="deleteArmed ? 'Tap again to confirm' : 'Delete'"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 shrink-0">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6M14 11v6" />
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </svg>
        <span class="whitespace-nowrap">{{ deleteArmed ? 'Confirm Delete' : 'Delete' }}</span>
      </button>
    </div>
    <!-- relative wrapper hosts the absolute-positioned selected-accent strip;
       inner padding-left already accounts for the strip width so content
       doesn't shift when selection toggles. The bg-white/black cover is
       what hides the action tray underneath when the row is at translate(0). -->
  <div
    ref="rowEl"
    class="cw-session-row group flex items-center gap-3 py-2.5 cursor-pointer w-full min-w-0 overflow-hidden select-none relative [-webkit-touch-callout:none] [-webkit-tap-highlight-color:transparent]"
    :class="[
      selected
        ? 'cw-session-row-selected bg-[var(--cw-panel-2)] '
        : 'cw-session-row-idle bg-white dark:bg-black [@media(hover:hover)]:hover:bg-[var(--cw-panel-2)] ',
      isHidden ? 'opacity-50 italic' : '',
    ]"
    :style="{
      paddingLeft: (12 + props.depth * 14) + 'px',
      paddingRight: '12px',
      '--cw-session-divider-left': (68 + props.depth * 14) + 'px',
    }"
    @click="onRowClick"
    @contextmenu="onContextMenu"
    @pointerdown="(e) => { onPressStart(e); onSwipeStart(e); }"
    @pointermove="(e) => { onPressMove(e); onSwipeMove(e); }"
    @pointerup="(e) => { onPressEnd(); onSwipeEnd(e); }"
    @pointercancel="(e) => { onPressEnd(); onSwipeEnd(e); }"
  >
    <!-- Accent strip for compact/non-WeChat skins. The WeChat skin uses the
         current full-width green selection surface instead. -->
    <span
      v-if="selected"
      class="cw-session-selected-strip absolute left-0 top-0 bottom-0 w-[3px] bg-[var(--cw-accent)]"
      aria-hidden="true"
    />
    <!-- Avatar: WeChat-style rounded-square (44px, ~6px radius).
         - With an emoji from the auto-titler: render it large on a soft
           neutral square so the emoji's own colors carry the recognition.
           Background still hashed from the cwd at low saturation so
           siblings stay color-grouped without fighting the emoji.
         - Without an emoji: full-saturation cwd-hashed gradient + the
           title's leading character in white. -->
    <div
      class="relative shrink-0 w-11 h-11 rounded-md flex items-center justify-center select-none shadow-sm"
      :class="avatarIsEmoji ? 'text-[26px] leading-none' : 'text-white font-semibold text-[17px]'"
      :style="{ background: avatarBg }"
      :title="cwd"
    >{{ avatarChar }}
    </div>

    <!-- Middle column: takes the full remaining width.
         Row 1 = title (flex-1) + time stamp (right).
         Row 2 = preview (flex-1) + status/unread (right).
         The right column was previously a separate flex-col stack that
         reserved ~50px for the entire row's height — that horizontal
         "dead zone" prevented preview text from extending into the
         lower-right where there's nothing but a 10×10 dot most of the
         time. Inlining time/status into their respective rows lets the
         preview line use almost the full row width. -->
    <div class="cw-session-copy min-w-0 flex-1">
      <!-- Top row: title (or rename input when editing) + time.
           items-start so the timestamp pins to the FIRST title line when a
           long title wraps to two (line-clamp-2 below) instead of floating to
           the vertical center of the taller block. -->
      <div class="cw-session-heading-row flex items-start gap-2 min-w-0">
        <div v-if="editing" class="flex items-center gap-1 flex-1 min-w-0" @click.stop>
          <input
            ref="titleInput"
            v-model="draftTitle"
            class="flex-1 min-w-0 text-sm bg-[var(--cw-panel-bg)] border border-[var(--cw-border)]  rounded px-1 py-0.5"
            @keydown="onTitleKey"
            @blur="commitRename"
          />
          <button
            type="button"
            class="shrink-0 text-[11px] px-1.5 py-0.5 rounded border border-[var(--cw-border)]  opacity-80 hover:opacity-100 disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="autoTitling"
            @mousedown.prevent
            @click="autoRetitleHere"
            title="Re-run auto-titler now and switch this session back to auto-managed"
          >{{ autoTitling ? "…" : "Auto" }}</button>
        </div>
        <div
          v-else
          class="cw-session-title flex-1 min-w-0 text-[15px] flex items-center gap-1.5 overflow-hidden"
          :title="`${title || (isDraft ? 'New chat' : shortId + '…')}${cwd ? '\n' + cwd : ''}`"
        >
          <span
            v-if="hasDraft"
            class="inline-block w-1.5 h-1.5 rounded-full bg-[var(--cw-warning)] shrink-0"
            title="Unsent draft"
          />
          <span
            v-if="pinned"
            class="text-xs text-[var(--cw-warning)] shrink-0 leading-none"
            title="Pinned"
          >★</span>
          <span class="line-clamp-2 min-w-0 font-medium">
            <template v-if="showRetitling">
              <span class="opacity-70 italic inline-flex items-center gap-1">
                <span class="inline-block animate-spin">⟳</span>
                Retitling…
              </span>
            </template>
            <template v-else-if="title">{{ title }}</template>
            <template v-else-if="isDraft"><span class="italic opacity-80">New chat</span></template>
            <template v-else><span class="font-mono">{{ shortId }}…</span></template>
          </span>
          <span
            v-if="title && titleIsManual && !showRetitling"
            class="text-[9px] opacity-40 leading-none shrink-0"
            title="Manually renamed — auto-retitle skips this session until you click Auto"
          >✎</span>
          <span
            v-if="isReadOnlySubagent"
            class="shrink-0 rounded bg-[color-mix(in_srgb,var(--cw-info)_14%,transparent)] px-1 py-0.5 text-[9px] font-medium leading-none text-[var(--cw-info)]"
            title="子 Agent 记录，只读"
          >只读</span>
        </div>
        <span
          v-if="timeLabel"
          class="cw-session-time shrink-0 text-[11px] opacity-50 leading-none whitespace-nowrap"
          :title="lastActivity"
        >{{ timeLabel }}</span>
      </div>
      <!-- Bottom row: preview (flex-1, truncates) + status dot / unread.
           When neither status nor unread is showing, the preview gets the
           entire row width minus the right padding. -->
      <div
        v-if="livePreview.text || isRunning || isFailed || unread > 0 || bgRunning > 0"
        class="flex items-center gap-2 min-w-0 mt-0.5"
      >
        <div
          v-if="livePreview.text"
          class="cw-session-preview flex-1 min-w-0 text-[13px] truncate"
          :class="{
            'opacity-60': livePreview.kind === 'preview',
             'text-[var(--cw-info)]': livePreview.kind === 'draft' || livePreview.kind === 'images',
             'text-[var(--cw-warning)]': livePreview.kind === 'retry',
            'opacity-70 italic': livePreview.kind === 'thinking',
            'opacity-70': livePreview.kind === 'pending',
          }"
          :title="livePreview.text"
        >{{ livePreview.text }}</div>
        <div v-else class="flex-1 min-w-0" />
         <div class="shrink-0 flex items-center gap-1.5 leading-none">
           <span
             v-if="capacityRetry"
             class="text-[11px] leading-none font-medium text-[var(--cw-warning)]"
             :title="`Selected model is busy. Automatic retry ${capacityRetry.attempt} of ${capacityRetry.maxAttempts}.`"
           >⟳{{ capacityRetry.attempt }}/{{ capacityRetry.maxAttempts }}<template
             v-if="capacityRetryWaitSeconds > 0"
           > {{ capacityRetryWaitSeconds }}s</template></span>
           <span
            v-if="bgRunning > 0"
            class="text-[11px] leading-none text-[var(--cw-info)] flex items-center gap-0.5"
            :title="`${bgRunning} background task${bgRunning === 1 ? '' : 's'} running`"
          ><span class="inline-block animate-spin">⟳</span>{{ bgRunning > 1 ? bgRunning : '' }}</span>
          <span
            v-if="isRunning"
            class="cw-session-running-dot relative flex h-2.5 w-2.5"
            title="Thinking…"
          >
            <span class="absolute inline-flex h-full w-full rounded-full bg-[var(--cw-success)] opacity-75 animate-ping" />
            <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-[var(--cw-success)]" />
          </span>
          <span
            v-else-if="isFailed"
            class="w-2.5 h-2.5 rounded-full bg-[var(--cw-danger)]"
            title="Last run failed"
          />
          <span
            v-if="unread > 0"
            class="cw-session-unread text-[11px] leading-none font-semibold rounded-full bg-[var(--cw-accent)] text-[var(--cw-accent-text)] px-1.5 min-w-[1.25rem] h-[1.25rem] flex items-center justify-center"
            :title="`${unread} unread ${unread === 1 ? 'reply' : 'replies'}`"
          >{{ unread > 99 ? '99+' : unread }}</span>
        </div>
      </div>
      <!-- Cwd line wraps (break-all) instead of truncating — long paths
           on mobile get clipped past a single line and the user can't
           see the full name. Wrapping keeps the path fully visible at
           the cost of a slightly taller row, which we agreed beats
           "click to read tooltip" UX on touch. -->
      <div
        v-if="!hideCwd && cwd"
        class="cw-session-cwd text-[12px] font-mono opacity-70 text-[var(--cw-text)]  break-all min-w-0"
        :class="livePreview.text ? 'mt-0' : 'mt-0.5'"
        :style="pathTint ? { color: pathTint } : undefined"
        :title="cwd"
      >{{ cwd }}</div>
    </div>
  </div>
  </div><!-- /swipe wrapper -->

  <Teleport to="body">
    <div
      v-if="menuOpen"
      class="cw-context-menu fixed z-50 min-w-[180px] rounded-lg border shadow-lg text-sm py-1"
      :style="menuStyle"
      @click.stop
    >
      <button
        v-if="item?.cwd"
        class="cw-context-menu-item w-full text-left px-3 py-1.5 flex items-center gap-2"
        :title="`Create an empty Codex chat in ${cwd}`"
        @click="newChatHere"
      >
        <span class="w-4 inline-block text-center">＋</span>
        New chat here<span v-if="currentGroup" class="opacity-50"> · {{ currentGroup }}</span>
      </button>
      <div v-if="item?.cwd" class="cw-context-menu-sep border-t my-1" />
      <button
        class="cw-context-menu-item w-full text-left px-3 py-1.5 flex items-center gap-2"
        @click="closeMenu(); void startRename()"
      >
        <span class="w-4 inline-block text-center">✎</span>
        Rename
      </button>
      <button
        class="cw-context-menu-item w-full text-left px-3 py-1.5 flex items-center gap-2"
        @click="togglePin"
      >
        <span class="w-4 inline-block text-center">{{ pinned ? '☆' : '★' }}</span>
        {{ pinned ? 'Unpin' : 'Pin' }}
      </button>
      <button
        class="cw-context-menu-item w-full text-left px-3 py-1.5 flex items-center gap-2"
        @click="toggleHide"
      >
        <span class="w-4 inline-block text-center">{{ isHidden ? '↺' : '×' }}</span>
        {{ isHidden ? 'Unhide' : 'Hide' }}
      </button>
      <div v-if="groupNames.length" class="cw-context-menu-sep border-t mt-1 pt-1">
        <div class="px-3 pb-1 text-[10px] uppercase tracking-wider opacity-60">Group</div>
        <select
          :value="currentGroup ?? ''"
          @change="onGroupChange"
          @click.stop
          class="cw-context-menu-item w-full px-3 py-1.5 text-sm bg-transparent cursor-pointer focus:outline-none"
        >
          <option value="">(none)</option>
          <option v-for="g in groupNames" :key="g" :value="g">{{ g }}</option>
        </select>
      </div>
    </div>
  </Teleport>
</template>
