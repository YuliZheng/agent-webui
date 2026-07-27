<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useSessionsStore } from "../stores/sessions.js";
import { usePrefsStore } from "../stores/prefs.js";
import { useUiStore } from "../stores/ui.js";
import { useDraftsStore } from "../stores/drafts.js";
import { searchContent, refreshBackend } from "../api/sessions.js";
import { useScrollTargetStore } from "../stores/scroll-target.js";
import { useSearchHighlightStore } from "../stores/search-highlight.js";
import { displayCwd } from "../util/cwd-display.js";
import { isOrdinarySidebarSessionVisible } from "../util/session-visibility.js";
import { APP_BACK_PRIORITY, registerAppBackHandler } from "../util/app-back.js";
import { setPwaLayerActive } from "../util/pwa-history.js";
import { wake as wsWake } from "../api/ws.js";
import SessionRow from "./SessionRow.vue";
import NewSessionModal from "./modals/NewSessionModal.vue";
import SettingsModal from "./modals/SettingsModal.vue";


const SIDEBAR_WIDTH_KEY = "cw:sidebar-width";
const MIN_WIDTH = 200;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 288; // matches w-72

// "flat" = collapse the per-cwd groups into a single recency-ranked list,
// with each row showing its own cwd. Active / Pinned / manual groups still
// render on top; only the auto cwd-bucket section gets flattened.
// v2 changes the first-run default to the WeChat-like flat recency list.
// Using a versioned key intentionally migrates the old grouped-by-default
// choice once; after that, the visible toggle still persists either mode.
const FLAT_MODE_KEY = "cw:sidebar-flat-mode-v2";
function loadFlatMode(): boolean {
  if (typeof localStorage === "undefined") return true;
  const saved = localStorage.getItem(FLAT_MODE_KEY);
  return saved === null ? true : saved === "1";
}
const flatMode = ref<boolean>(loadFlatMode());
watch(flatMode, (v) => {
  try { localStorage.setItem(FLAT_MODE_KEY, v ? "1" : "0"); } catch { /* noop */ }
});

function loadWidth(): number {
  if (typeof localStorage === "undefined") return DEFAULT_WIDTH;
  const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (!raw) return DEFAULT_WIDTH;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
}

const sidebarWidth = ref<number>(loadWidth());
const dragging = ref(false);
let dragStartX = 0;
let dragStartWidth = 0;

// Reactive desktop check — width is only applied as inline style when at
// md+ (≥768 px). Without this, the persisted desktop width (e.g. 950 px
// after the user dragged the resizer wide) was leaking into mobile and
// pushing the chat list off-screen. The Tailwind `md:[width:var(...)]`
// arbitrary-property syntax we tried first didn't reliably scope to the
// breakpoint with var() inside.
const isDesktop = ref<boolean>(typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches);
let mediaQuery: MediaQueryList | null = null;
function onMediaChange(e: MediaQueryListEvent) { isDesktop.value = e.matches; }
if (typeof window !== "undefined") {
  mediaQuery = window.matchMedia("(min-width: 768px)");
  mediaQuery.addEventListener("change", onMediaChange);
}
const asideStyle = computed<Record<string, string>>(() =>
  isDesktop.value ? { width: sidebarWidth.value + "px" } : {},
);

function onResizeMouseDown(e: MouseEvent) {
  dragging.value = true;
  dragStartX = e.clientX;
  dragStartWidth = sidebarWidth.value;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", onResizeMouseMove);
  window.addEventListener("mouseup", onResizeMouseUp);
  e.preventDefault();
}

function onResizeMouseMove(e: MouseEvent) {
  if (!dragging.value) return;
  const next = dragStartWidth + (e.clientX - dragStartX);
  sidebarWidth.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next));
}

function onResizeMouseUp() {
  if (!dragging.value) return;
  dragging.value = false;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  window.removeEventListener("mousemove", onResizeMouseMove);
  window.removeEventListener("mouseup", onResizeMouseUp);
  try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value)); } catch { /* noop */ }
}

onBeforeUnmount(() => {
  window.removeEventListener("mousemove", onResizeMouseMove);
  window.removeEventListener("mouseup", onResizeMouseUp);
  mediaQuery?.removeEventListener("change", onMediaChange);
});

// ─── Pull-to-refresh on the sidebar ──────────────────────────────────────
// WeChat-style: at the very top of the chat list, drag down past the
// threshold then release to wake the WS and re-fetch the sessions list.
// Avoids reloading the whole page through the corporate proxy when the
// sidebar previews / live updates feel out of sync after a long suspend.
//
// touchmove must be NON-passive so we can preventDefault and suppress the
// native overscroll bounce while we own the gesture.
type PullState = "idle" | "pulling" | "refreshing";
const sidebarScroller = ref<HTMLDivElement | null>(null);
const pullState = ref<PullState>("idle");
const pullDistance = ref(0);
const PULL_THRESHOLD = 60;
const PULL_MAX = 90;
const PULL_REFRESH_HOLD = 50;
let pullStartY = 0;
let pullActive = false;

function onPullTouchStart(e: TouchEvent) {
  if (pullState.value === "refreshing") return;
  const el = sidebarScroller.value;
  if (!el) return;
  if (el.scrollTop > 0) return;
  if (e.touches.length !== 1) return;
  pullStartY = e.touches[0]?.clientY ?? 0;
  pullActive = true;
}

function onPullTouchMove(e: TouchEvent) {
  if (!pullActive || pullState.value === "refreshing") return;
  const el = sidebarScroller.value;
  if (!el) return;
  if (el.scrollTop > 0) {
    pullActive = false;
    pullDistance.value = 0;
    pullState.value = "idle";
    return;
  }
  const y = e.touches[0]?.clientY ?? pullStartY;
  const dy = y - pullStartY;
  if (dy <= 0) {
    pullDistance.value = 0;
    pullState.value = "idle";
    return;
  }
  pullDistance.value = Math.min(dy * 0.5, PULL_MAX);
  pullState.value = "pulling";
  e.preventDefault();
}

async function onPullTouchEnd() {
  if (!pullActive) return;
  pullActive = false;
  if (pullState.value !== "pulling") return;
  if (pullDistance.value >= PULL_THRESHOLD) {
    await runPullRefresh();
  } else {
    pullDistance.value = 0;
    pullState.value = "idle";
  }
}

async function runPullRefresh() {
  pullState.value = "refreshing";
  pullDistance.value = PULL_REFRESH_HOLD;
  try {
    // Kick the WS first so any pending stream-line / status broadcasts
    // we missed (suspend, network blip) start flowing before we re-pull
    // the source of truth.
    wsWake({ forceReconnect: true });
    // Force-reconnect handles the engaged tail through ws.ts's onopen
    // re-subscribe path. Calling refreshEngaged() immediately while the new
    // socket is still CONNECTING can queue unsubscribe/subscribe frames in the
    // wrong order and tear down the just-restored tail.
    // Wipe stale per-session statuses BEFORE fetchAll repopulates them.
    // hydrateList only sets statuses for sessions still in the returned
    // list — without the wipe, a session that finished while we were
    // offline AND dropped off the recent-N list would stay stuck on a
    // stale "running" forever.
    sessions.clearAllStatus();
    await Promise.all([
      // Backend rescan: re-adopt any TUI / orphan claudes that started
      // after webui boot, and re-walk every jsonl to recompute
      // isResponding (chokidar drops events under load / on resume).
      refreshBackend().catch(() => undefined),
      // Frontend source-of-truth refetch: titles, mtime, previews, fork
      // tree, AND the freshly-recomputed status for each session.
      sessions.fetchAll().catch(() => undefined),
      // Per-user preferences: hidden sessions, groups, thinking trigger,
      // theme. Less commonly stale but cheap to refetch.
      prefs.load().catch(() => undefined),
      // Floor: keep the spinner up long enough to feel intentional
      // even when everything resolves in <100 ms.
      new Promise((r) => setTimeout(r, 350)),
    ]);
  } finally {
    pullDistance.value = 0;
    pullState.value = "idle";
  }
}

onMounted(() => {
  const el = sidebarScroller.value;
  if (!el) return;
  el.addEventListener("touchstart", onPullTouchStart, { passive: true });
  el.addEventListener("touchmove", onPullTouchMove, { passive: false });
  el.addEventListener("touchend", onPullTouchEnd, { passive: true });
  el.addEventListener("touchcancel", onPullTouchEnd, { passive: true });
});
onBeforeUnmount(() => {
  const el = sidebarScroller.value;
  if (!el) return;
  el.removeEventListener("touchstart", onPullTouchStart);
  el.removeEventListener("touchmove", onPullTouchMove);
  el.removeEventListener("touchend", onPullTouchEnd);
  el.removeEventListener("touchcancel", onPullTouchEnd);
});

const pullIndicatorLabel = computed(() => {
  if (pullState.value === "refreshing") return "刷新中…";
  if (pullDistance.value >= PULL_THRESHOLD) return "松开刷新";
  if (pullDistance.value > 0) return "下拉刷新";
  return "";
});

const sessions = useSessionsStore();
const prefs = usePrefsStore();
const drafts = useDraftsStore();
const scrollTarget = useScrollTargetStore();
const searchHighlight = useSearchHighlightStore();

// Click handler for search results: if this row matched on content (uuid
// returned by backend), arm a scroll target so MessageList lands on that
// message instead of bottom-pinning. SessionRow's own pick() runs right
// after via the normal click bubble. Using @click.capture so we set the
// target BEFORE selectedSessionId changes and MessageList remounts.
function onSearchResultCaptureClick(id: string) {
  const match = contentScores.value.get(id);
  const fallbackUuid = match?.lastMatchIndex !== null
    && match?.lastMatchIndex !== undefined
    && sessions.byId[id]?.agent === "codex"
    ? `codex-line-${match.lastMatchIndex}`
    : null;
  const uuid = match?.lastMatchUuid ?? fallbackUuid;
  if (uuid) {
    scrollTarget.set(id, uuid, searchQuery.value, match?.lastMatchIndex ?? null);
  }
}

// Effective recency used for ALL sidebar ordering. It MUST mirror the exact
// timestamp SessionRow renders beside each row — `lastTurnAt`, falling back to
// file mtime — so the visible order can never contradict the visible labels (a
// row showing "Mon" must not outrank one showing "13:53").
//
// We deliberately do NOT factor in `lastBoundaryAt` here. That field is seeded
// from file mtime during scanAll and bumped to now() on responding-state
// transitions, so a sidechain write that touches the jsonl's mtime (a late
// last-prompt record, an interrupted-mid-stream turn) leaks into it — floating
// a stale row to the very top while it still DISPLAYS an old time. That mtime
// leak via the boundary term was the recurring sort/label mismatch. Genuinely
// running sessions still surface: the dedicated "Active" section pins them by
// status (isRunningSession), and `lastTurnAt` jumps to now() the moment
// their turn starts, so dropping the boundary term loses no float-to-top.
// draftMs keeps a just-typed (no jsonl yet) row at the top.
function effectiveMtime(id: string): number {
  const item = sessions.byId[id];
  const turnMs = item ? Date.parse(item.lastTurnAt || "") : NaN;
  const fileMs = item ? Date.parse(item.mtime || "") : NaN;
  const draftMs = drafts.editedAt(id);
  const turn = Number.isFinite(turnMs) ? turnMs : 0;
  const file = Number.isFinite(fileMs) ? fileMs : 0;
  // Mirror SessionRow's `lastTurnAt || mtime`: file mtime is only a fallback
  // for sessions with no turn timestamp yet (brand-new / drain in progress).
  const base = turn > 0 ? turn : file;
  return Math.max(base, draftMs);
}
const ui = useUiStore();

const showNew = ref(false);
const mobileHeaderMenuOpen = ref(false);

// WeChat-style search "page". Tap the ⌕ button to swap the entire sidebar
// (header + chat tree) for a focused search view: back arrow + large input
// + flat ranked results. Esc and the back button both close. Closing also
// clears the query so the next open starts fresh.
const searchOpen = ref(false);
const searchInputRef = ref<HTMLInputElement | null>(null);
function toggleSearch() {
  if (searchOpen.value) closeSearch();
  else openSearch();
}
function openSearch() {
  mobileHeaderMenuOpen.value = false;
  searchOpen.value = true;
  // Re-focus next tick so :autofocus works reliably on Safari/iOS where
  // the attribute is sometimes ignored when the element wasn't in the DOM
  // at page-load time.
  void nextTick().then(() => searchInputRef.value?.focus());
}
function closeSearch() {
  searchOpen.value = false;
  searchQuery.value = "";
}

const currentCwd = computed<string | null>(() => {
  const id = ui.selectedSessionId;
  return id ? (sessions.byId[id]?.cwd ?? null) : null;
});

// Spawn a pending draft in `cwd` — clicked from the per-cwd-group "+"
// button in the IM-style chat list. Inherits the prev session's manual
// group when called without a target cwd (back-compat: was triggered by
// the old "+ Here" button which used the currently-selected session's cwd).
function quickHere(targetCwd?: string) {
  const cwd = targetCwd ?? currentCwd.value;
  if (!cwd) return;
  // Don't spawn claude yet — make a pending draft in the sidebar that the
  // user can type into. The actual newSession call fires from PromptInput
  // when they hit send.
  const prev = ui.selectedSessionId;
  const draftId = sessions.createPending(cwd, "codex");
  if (prev) {
    const group = prefs.groupOf(prev);
    if (group) prefs.moveToGroup(draftId, group);
  }
  ui.select(draftId);
}
const showSettings = ref(false);
let unregisterAppBack: (() => void) | undefined;
const sidebarLayerOpen = computed(() =>
  showSettings.value
  || showNew.value
  || searchOpen.value
  || mobileHeaderMenuOpen.value,
);
watch(sidebarLayerOpen, open => {
  setPwaLayerActive("sidebar-overlay", open, ui.selectedSessionId);
});

function handleAppBack(): boolean {
  if (showSettings.value) {
    showSettings.value = false;
    return true;
  }
  if (showNew.value) {
    showNew.value = false;
    return true;
  }
  if (searchOpen.value) {
    closeSearch();
    return true;
  }
  if (mobileHeaderMenuOpen.value) {
    mobileHeaderMenuOpen.value = false;
    return true;
  }
  return false;
}

// Per-group collapsed state. Keys are group names plus the special keys
// "__pinned__" and "__ungrouped__" for the built-in sections. Default = expanded (false).
const collapsed = reactive<Record<string, boolean>>({});
function toggle(key: string) { collapsed[key] = !collapsed[key]; }

// Re-sort the master id list by effectiveMtime so drafts and just-sent
// (pre-jsonl-write) sessions bubble up like server-side touched ones.
// sessions.list itself stays sorted by raw jsonl mtime — we just override
// for sidebar display.
const allIds = computed(() => {
  const ids = sessions.list.map((s) => s.id);
  ids.sort((a, b) => effectiveMtime(b) - effectiveMtime(a));
  return ids;
});
const groupedIds = computed(() => new Set(Object.values(prefs.groups).flatMap((g) => g.sessions)));

// Free-text search across title, cwd (raw + display-stripped), the short
// session-id prefix, AND the conversation content (debounced backend grep
// over user/assistant text in each jsonl). Empty query is a no-op.
// Multi-word queries match if every token appears somewhere (AND semantics).
const searchQuery = ref("");
const searchTokens = computed(() =>
  searchQuery.value.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean),
);

// Mirror the search box into the global highlight store on every
// keystroke (no debounce — the highlight pass inside MessageList has
// its own debounce). Empty query clears.
watch(searchQuery, (q) => {
  const trimmed = q.trim();
  if (trimmed.length === 0) searchHighlight.clear();
  else searchHighlight.set(trimmed);
});
onBeforeUnmount(() => searchHighlight.clear());

// Backend content-search results for the current query. Updated on a debounce.
// id -> content match score (occurrences across all tokens).
// Map<sessionId, { score, lastMatchUuid, lastMatchIndex }>. lastMatchUuid is the uuid of
// the LAST record in that session that contains the first query token —
// used by the click handler to set a scroll target so MessageList lands on
// the latest matching message instead of bottom-pinning.
const contentScores = ref<Map<string, {
  score: number;
  lastMatchUuid: string | null;
  lastMatchIndex: number | null;
}>>(new Map());
const contentSearchInflight = ref(false);
const contentSearchToken = ref(0);

let contentSearchTimer: ReturnType<typeof setTimeout> | null = null;
const CONTENT_SEARCH_DEBOUNCE_MS = 200;
// English noise queries ("is", "to") are filtered out at <3 chars. Chinese
// 2-char words ("排序", "搜索", "重启") are extremely common and meaningful,
// so allow 2 chars when the query contains any non-ASCII / CJK character.
const CONTENT_SEARCH_MIN_CHARS_ASCII = 3;
const CONTENT_SEARCH_MIN_CHARS_CJK = 2;
const CJK_RE = /[^\x00-\x7F]/;
function minCharsFor(q: string): number {
  return CJK_RE.test(q) ? CONTENT_SEARCH_MIN_CHARS_CJK : CONTENT_SEARCH_MIN_CHARS_ASCII;
}
const MAX_RANKED_RESULTS = 100;

// Per-token score boosts when the term hits in the metadata (always-known on
// the frontend without a backend round trip). Tuned so a title hit reliably
// outranks a content-only hit, and a path hit beats most content hits but not
// titles.
const TITLE_TOKEN_BOOST = 50;
const CWD_TOKEN_BOOST = 20;
// An id hit outranks a content hit but sits below a title hit. Searching a
// (partial) session id is a deliberate "take me to THIS chat" act.
const ID_TOKEN_BOOST = 40;

// A token is "id-shaped" when it's only hex/hyphen chars and ≥8 long — i.e.
// a full uuid (019eb4a9-7fdb-…), a hyphenated chunk, or the 8-char prefix.
// Gating full-id matching behind this keeps ordinary words (and short hex-ish
// fragments) from accidentally matching the 36-char uuid substring.
function isIdToken(tok: string): boolean {
  return /^[0-9a-f][0-9a-f-]{7,}$/.test(tok);
}

watch(searchQuery, (q: string) => {
  if (contentSearchTimer) { clearTimeout(contentSearchTimer); contentSearchTimer = null; }
  // Clear stale results immediately so the UI doesn't show old content matches
  // while the user keeps typing.
  contentScores.value = new Map();
  contentSearchInflight.value = false;
  if (q.trim().length < minCharsFor(q)) return;
  contentSearchToken.value += 1;
  const myToken = contentSearchToken.value;
  contentSearchTimer = setTimeout(async () => {
    contentSearchTimer = null;
    contentSearchInflight.value = true;
    try {
      const matches = await searchContent(q);
      if (myToken !== contentSearchToken.value) return;
      contentScores.value = new Map(matches.map((m) => [m.id, {
        score: m.score,
        lastMatchUuid: m.lastMatchUuid,
        lastMatchIndex: m.lastMatchIndex,
      }]));
    } catch {
      if (myToken === contentSearchToken.value) contentScores.value = new Map();
    } finally {
      if (myToken === contentSearchToken.value) contentSearchInflight.value = false;
    }
  }, CONTENT_SEARCH_DEBOUNCE_MS);
});

const searchActive = computed(() => searchTokens.value.length > 0);

// When the whole query is one id-shaped token that resolves to a real session,
// surface it as a dedicated "ID match" card pinned above the ranked results.
// Preference: exact id > prefix > substring. Returns the session id or null.
const idMatch = computed<string | null>(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q || !isIdToken(q)) return null;
  let prefix: string | null = null;
  let sub: string | null = null;
  for (const id of allIds.value) {
    const f = id.toLowerCase();
    if (f === q) return id;
    if (!prefix && f.startsWith(q)) prefix = id;
    else if (!sub && f.includes(q)) sub = id;
  }
  return prefix ?? sub;
});

// Return the search relevance score for `id`, or null if it doesn't match
// the active query. Score is title boost + cwd boost + content occurrences.
function scoreFor(id: string): number | null {
  const tokens = searchTokens.value;
  if (tokens.length === 0) return null;
  const item = sessions.byId[id];
  const title = (item?.title ?? "").toLowerCase();
  const cwdRaw = (item?.cwd ?? "").toLowerCase();
  const cwdDisp = displayCwd(item?.cwd, ui.home).toLowerCase();
  const idShort = id.slice(0, 8).toLowerCase();
  const idFull = id.toLowerCase();
  const contentScore = contentScores.value.get(id)?.score ?? 0;
  // Id-shaped tokens (full uuid / long prefix) match anywhere in the full id;
  // ordinary tokens keep the looser short-prefix match they always had.
  const idHit = (tok: string) => (isIdToken(tok) ? idFull.includes(tok) : idShort.includes(tok));

  let titleHits = 0, cwdHits = 0, idHits = 0;
  for (const tok of tokens) {
    if (title.includes(tok)) titleHits++;
    if (cwdRaw.includes(tok) || cwdDisp.includes(tok)) cwdHits++;
    if (idHit(tok)) idHits++;
  }
  // A session matches if EVERY token is found somewhere — same AND semantics
  // as before. Metadata hits and content hits are pooled per token.
  for (const tok of tokens) {
    const found =
      title.includes(tok) ||
      cwdRaw.includes(tok) ||
      cwdDisp.includes(tok) ||
      idHit(tok) ||
      contentScore > 0;  // backend already AND'd content matches across tokens
    if (!found) return null;
  }
  return titleHits * TITLE_TOKEN_BOOST + cwdHits * CWD_TOKEN_BOOST + idHits * ID_TOKEN_BOOST + contentScore;
}

function matchesSearch(id: string): boolean {
  // No active query → every session is "matching" so the tree view shows
  // everything. Only fall through to scoreFor when there's actually a query
  // (it returns null both for "no query" AND "doesn't match" — we have to
  // distinguish those two cases here or the tree empties out).
  if (searchTokens.value.length === 0) return true;
  return scoreFor(id) !== null;
}

interface RankedRow { id: string; score: number; mtimeMs: number }

// Flat search results: once a session matches, order it exactly like a chat
// history — newest activity first. Session id is only a deterministic
// tie-break when two sessions have the exact same activity timestamp.
//
// Hidden sessions ARE included here (unlike the chat tree, which filters them
// via visibleIds). Search is a deliberate "find me this thing" act — hiding a
// session declutters the sidebar but shouldn't make it permanently
// unfindable. This matches WeChat, where archived chats still surface in
// search. SessionRow already renders hidden rows dimmed+italic and offers
// "Unhide" in its menu, so a hidden hit is visually distinct and recoverable.
const rankedResults = computed<RankedRow[]>(() => {
  if (!searchActive.value) return [];
  const out: RankedRow[] = [];
  for (const id of allIds.value) {
    if (id === idMatch.value) continue; // shown as the pinned ID-match card
    const score = scoreFor(id);
    if (score === null) continue;
    out.push({ id, score, mtimeMs: effectiveMtime(id) });
  }
  out.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.id.localeCompare(b.id));
  return out.slice(0, MAX_RANKED_RESULTS);
});

const visibleIds = computed(() =>
  allIds.value.filter(
    (id) =>
      isOrdinarySidebarSessionVisible(sessions.byId[id], prefs, ui.selectedSessionId) &&
      matchesSearch(id),
  ),
);
const totalVisibleUnread = computed(() =>
  visibleIds.value.reduce((total, id) => total + (sessions.unreadBySession[id] ?? 0), 0),
);
const mobileUnreadLabel = computed(() =>
  totalVisibleUnread.value > 99 ? "99+" : String(totalVisibleUnread.value),
);

// The exact top-to-bottom order of rows as rendered, deduped (Active/Pinned
// surface sessions that also live in a group below — keep the first/topmost
// occurrence). Mirrors the template section-for-section so Tab nav matches
// what the eye sees: forks stay under their parent, collapsed groups are
// skipped (their rows aren't visible), and search mode follows the ranked
// results. Keep this in sync with the template render order below.
function navOrder(): string[] {
  if (searchActive.value) {
    const ranked = rankedResults.value.map((r) => r.id);
    return idMatch.value ? [idMatch.value, ...ranked] : ranked;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => { if (!seen.has(id)) { seen.add(id); out.push(id); } };
  if (!collapsed["__active__"]) activeSessionIds.value.forEach(push);
  if (pinnedSessionIds.value.length && !collapsed["__pinned__"]) pinnedSessionIds.value.forEach(push);
  for (const name of Object.keys(prefs.groups)) {
    if (!collapsed[name]) idsInGroup(name).forEach(push);
  }
  if (flatMode.value) {
    for (const row of orderWithForks(ungroupedIds.value)) push(row.id);
  } else {
    for (const g of cwdGroups.value) {
      if (!collapsed["cwd:" + g.key]) for (const row of g.rows) push(row.id);
    }
  }
  return out;
}

// Move to the next / previous conversation in visible list order, clamping at
// the ends (no wrap from bottom→top or top→bottom). Goes through ui.select so
// it marks-read + pushes browser history like a normal click, then scrolls the
// newly-selected row into view so the sidebar follows the selection.
function switchSession(dir: 1 | -1) {
  const ids = navOrder();
  if (ids.length === 0) return;
  const idx = ui.selectedSessionId ? ids.indexOf(ui.selectedSessionId) : -1;
  const next = idx === -1
    ? (dir === 1 ? 0 : ids.length - 1)
    : Math.min(Math.max(idx + dir, 0), ids.length - 1);
  const id = ids[next];
  if (!id) return;
  ui.select(id);
  void nextTick(() => {
    document
      .querySelector(`[data-session-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });
}

function isComposerTextarea(target: EventTarget | null): target is HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement
    && (target.classList.contains("cw-composer-textarea")
      || target.classList.contains("cw-cc-textarea"));
}

function isSingleVisualLine(textarea: HTMLTextAreaElement): boolean {
  const style = window.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    return !textarea.value.includes("\n");
  }

  // scrollHeight cannot answer this reliably because the composer itself is
  // user-resizable: an empty one-line textarea may be 200+ px tall. Lay the
  // value out in a disposable, invisible mirror with the exact content width
  // and typography instead. The trailing zero-width glyph makes an empty
  // value and a value ending in "\n" both produce their real final line.
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  const mirror = document.createElement("div");
  Object.assign(mirror.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    boxSizing: "content-box",
    width: `${Math.max(1, textarea.clientWidth - paddingLeft - paddingRight)}px`,
    margin: "0",
    padding: "0",
    border: "0",
    whiteSpace: "pre-wrap",
    overflowWrap: style.overflowWrap,
    wordBreak: style.wordBreak,
    font: style.font,
    letterSpacing: style.letterSpacing,
    lineHeight: style.lineHeight,
    tabSize: style.tabSize,
  });
  mirror.textContent = `${textarea.value}\u200b`;
  document.body.appendChild(mirror);
  const renderedHeight = mirror.getBoundingClientRect().height;
  mirror.remove();
  // Allow sub-pixel font/layout rounding, but leave a wide gap before two
  // actual lines (2 × lineHeight) so wrapped text is never misclassified.
  return renderedHeight <= lineHeight * 1.45;
}

// Keep the established Tab / Shift+Tab navigation everywhere. In the WeChat
// skin, also mirror current desktop WeChat: ArrowUp/ArrowDown switch chats
// while the composer is visually one line, but return to normal caret
// navigation as soon as explicit newlines or wrapping make it multiline.
// A closer control may consume a key first (e.g. slash-menu Up/Down); input,
// rename, settings, IME, and modified-arrow behavior remain untouched.
function onSessionNavKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return;
  if (e.key === "Escape" && mobileHeaderMenuOpen.value) {
    e.preventDefault();
    mobileHeaderMenuOpen.value = false;
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (
    (e.key === "ArrowUp" || e.key === "ArrowDown")
    && !e.shiftKey
    && prefs.messageDisplayStyle === "wechat"
    && isComposerTextarea(e.target)
    && isSingleVisualLine(e.target)
  ) {
    e.preventDefault();
    switchSession(e.key === "ArrowUp" ? -1 : 1);
    return;
  }

  if (e.key !== "Tab") return;
  const ae = document.activeElement as HTMLElement | null;
  if (ae && (ae.tagName === "INPUT" || ae.isContentEditable)) return;
  e.preventDefault();
  switchSession(e.shiftKey ? -1 : 1);
}
onMounted(() => {
  window.addEventListener("keydown", onSessionNavKey);
  unregisterAppBack = registerAppBackHandler(handleAppBack, APP_BACK_PRIORITY.sheet);
});
onBeforeUnmount(() => {
  unregisterAppBack?.();
  window.removeEventListener("keydown", onSessionNavKey);
});

const pinnedSessionIds = computed(() =>
  prefs.pinned
    .filter((p): p is { kind: "session"; id: string } => p.kind === "session")
    .map((p) => p.id)
    .filter((id) => visibleIds.value.includes(id))
    .sort((a, b) => effectiveMtime(b) - effectiveMtime(a)),
);

// "Active" pseudo-section at the very top: any visible session that is
// either mid-turn (statusBySession==="running" covers "processing now"
// and "drain queued prompts in flight" under M1-M4 queue semantics) OR
// has unread assistant output the user hasn't seen yet. Same pattern as
// Pinned — sessions still render in their cwd-group below, so this is
// an extra surfacing. Running sessions sort before unread-only ones so
// in-flight work stays at the very top; within each bucket, most-recent
// activity wins.
function isRunningSession(id: string): boolean {
  return sessions.statusBySession[id] === "running";
}
const activeSessionIds = computed(() => {
  // Section is opt-out via prefs — when hidden, return empty so the whole
  // block (and its border) disappears. The sessions still show in their
  // normal cwd-group / flat-list position below.
  if (prefs.showActiveSection === false) return [];
  const ids = visibleIds.value.filter((id) =>
    isRunningSession(id) ||
    (sessions.unreadBySession[id] ?? 0) > 0,
  );
  ids.sort((a, b) => {
    const ar = isRunningSession(a) ? 1 : 0;
    const br = isRunningSession(b) ? 1 : 0;
    if (ar !== br) return br - ar;
    return effectiveMtime(b) - effectiveMtime(a);
  });
  return ids;
});

// Pinning a session adds an extra "Pinned" entry on top, but the session
// stays in its original cwd auto-group / manual group too. The same row will
// highlight in both places when selected — that's expected and intentional.
const ungroupedIds = computed(() =>
  visibleIds.value.filter((id) => !groupedIds.value.has(id)),
);

function idsInGroup(name: string): string[] {
  const g = prefs.groups[name];
  if (!g) return [];
  return g.sessions.filter((id) => visibleIds.value.includes(id));
}

interface OrderedRow { id: string; depth: number }
interface CwdGroup { key: string; label: string; rows: OrderedRow[]; latestMtime: number }

// Reorder a flat list of sessionIds into a parent-then-indented-children tree.
// A session is treated as a child if its parentSessionId is also in `ids`;
// otherwise it's rendered at the top level (an "orphan" fork is shown flat).
// Children inherit the order they had in `ids` (mtime-desc), which means the
// most-recently-touched fork appears first under its parent.
//
// Cycle-safe: a `visited` set guards against infinite recursion if the
// underlying parent map has a cycle (which can happen with corrupted
// forks.json from older detector versions). After the normal root-first
// pass, any session not yet visited is rendered at depth 0. This guarantees
// every session in `ids` shows up exactly once, no matter the data.
function orderWithForks(ids: string[]): OrderedRow[] {
  const idSet = new Set(ids);
  const childrenOf = new Map<string, string[]>();
  for (const id of ids) {
    const parent = sessions.byId[id]?.parentSessionId ?? null;
    if (parent && parent !== id && idSet.has(parent)) {
      const arr = childrenOf.get(parent) ?? [];
      arr.push(id);
      childrenOf.set(parent, arr);
    }
  }
  // Rank each root/fork by the FRESHEST activity anywhere in its fork tree
  // (subtree-max effectiveMtime), not just its own. Without this a parent
  // whose last turn is old sinks to the bottom even when one of its forks
  // was just active — dragging the recently-used fork down with it. Memoized;
  // cycle-guarded so corrupted forks.json can't infinite-loop.
  const subMax = new Map<string, number>();
  const computing = new Set<string>();
  function subtreeMax(id: string): number {
    const cached = subMax.get(id);
    if (cached !== undefined) return cached;
    if (computing.has(id)) return effectiveMtime(id);
    computing.add(id);
    let m = effectiveMtime(id);
    for (const k of childrenOf.get(id) ?? []) m = Math.max(m, subtreeMax(k));
    computing.delete(id);
    subMax.set(id, m);
    return m;
  }
  const bySubtreeDesc = (a: string, b: string) => subtreeMax(b) - subtreeMax(a);
  const out: OrderedRow[] = [];
  const visited = new Set<string>();
  function visit(id: string, depth: number) {
    if (visited.has(id)) return;
    visited.add(id);
    out.push({ id, depth });
    const kids = childrenOf.get(id);
    if (!kids) return;
    // Siblings ordered by their own subtree freshness (newest fork first).
    for (const k of [...kids].sort(bySubtreeDesc)) visit(k, depth + 1);
  }
  // Pass 1: traditional roots — no parent or parent not in this list —
  // ordered by their subtree's freshest activity so a tree with a recently
  // used fork floats up as a unit.
  const roots = ids.filter((id) => {
    const parent = sessions.byId[id]?.parentSessionId ?? null;
    return !parent || !idSet.has(parent);
  });
  for (const id of [...roots].sort(bySubtreeDesc)) visit(id, 0);
  // Pass 2: anything still unvisited (cycle members) gets surfaced at depth 0
  // so the user never loses a session.
  for (const id of ids) visit(id, 0);
  return out;
}

// Auto-group ungrouped (and unpinned) sessions by their cwd. Group label is
// the same display string SessionRow uses; sessions within stay mtime-desc
// (then re-ordered so each fork sits under its parent) and groups themselves
// sort by their newest session's mtime.
const cwdGroups = computed<CwdGroup[]>(() => {
  const buckets = new Map<string, { key: string; label: string; ids: string[]; latestMtime: number }>();
  for (const id of ungroupedIds.value) {
    const item = sessions.byId[id];
    if (!item) continue;
    const key = item.cwd || "(no cwd)";
    const label = displayCwd(item.cwd, ui.home);
    let g = buckets.get(key);
    if (!g) {
      g = { key, label, ids: [], latestMtime: 0 };
      buckets.set(key, g);
    }
    g.ids.push(id);
    const t = effectiveMtime(id);
    if (t > g.latestMtime) g.latestMtime = t;
  }
  const groups: CwdGroup[] = [];
  for (const g of buckets.values()) {
    groups.push({ key: g.key, label: g.label, rows: orderWithForks(g.ids), latestMtime: g.latestMtime });
  }
  return groups.sort((a, b) => b.latestMtime - a.latestMtime);
});

const caret = (key: string) => (collapsed[key] ? "▸" : "▾");

// Sum of unread badges across the rows in a group. Used to surface a small
// count next to a COLLAPSED group's header so the user can see "there are
// new replies hidden in here" without expanding to find which row. Expanded
// groups don't need this — the per-row badges are visible.
function unreadInIds(ids: string[]): number {
  let n = 0;
  for (const id of ids) n += sessions.unreadBySession[id] ?? 0;
  return n;
}

// True iff any session in `ids` is currently running. Used to paint a green
// pulsing dot on COLLAPSED group headers, mirroring the per-row dot — same
// rationale as unreadInIds: the user shouldn't have to expand the group to
// learn "something in here is mid-turn".
function runningInIds(ids: string[]): boolean {
  for (const id of ids) {
    if (isRunningSession(id)) return true;
  }
  return false;
}
</script>

<template>
  <!-- Width is only applied as an inline style on desktop (≥768 px). On
       mobile the sidebar grows via the parent's flex-1 to fit the viewport.
       Earlier attempt with Tailwind's md:[width:var(--sidebar-w)] arbitrary
       property leaked the desktop width to mobile breakpoints. max-w-full
       caps it as a final safety net. -->
  <aside
    class="cw-sidebar h-full md:border-r border-[var(--cw-border)]  flex flex-col relative max-w-full min-w-0"
    :style="asideStyle"
  >
    <!-- WeChat-style search page: when active, replaces the entire sidebar
         (header + chat list) with a focused search-only view. Click ← to
         exit, or hit Esc. The chat-tree state below is preserved (v-if on
         the inner blocks, not on the sidebar) so coming back is instant. -->
    <template v-if="searchOpen">
      <div class="cw-sidebar-search-header flex items-center gap-2 px-3 py-2 border-b border-[var(--cw-border)]  shrink-0">
        <button
          @click="(e) => { closeSearch(); (e.currentTarget as HTMLElement).blur(); }"
          class="shrink-0 w-9 h-9 rounded-full flex items-center justify-center opacity-70 [@media(hover:hover)]:hover:opacity-100 [@media(hover:hover)]:hover:bg-[var(--cw-panel-2)]  transition focus:outline-none"
          title="Back to chats (Esc)"
          aria-label="Back to chats"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </button>
        <div class="relative flex-1 min-w-0">
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            type="text"
            placeholder="Search title, path, or content…"
            class="cw-sidebar-search-input w-full text-sm rounded-lg bg-[var(--cw-panel-2)]  border-0 pl-3 pr-8 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--cw-focus-ring)]"
            @keydown.esc.prevent="closeSearch"
            autofocus
          />
          <span
            v-if="contentSearchInflight"
            class="absolute right-8 top-1/2 -translate-y-1/2 text-[10px] opacity-60"
            title="Searching conversation content…"
          >…</span>
          <button
            v-if="searchQuery"
            class="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center text-sm opacity-60 hover:opacity-100 hover:bg-[var(--cw-panel-2)] "
            @click="searchQuery = ''"
            title="Clear"
            aria-label="Clear search"
          >×</button>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain min-w-0">
        <template v-if="!searchActive">
          <div class="px-4 py-8 text-sm opacity-60 select-none text-center">
            Type to search across titles, paths, and conversation content.
          </div>
        </template>
        <template v-else>
          <!-- Pinned ID match: the query is a session id resolving to a real
               chat. Reuse the normal SessionRow (avatar / title / preview / time)
               for visual consistency, marked with a left accent + a small label
               so it reads as the exact-address hit, separated from the fuzzy
               title/content results below. The id itself is already visible in
               the search box, so we don't repeat it here. -->
          <div v-if="idMatch" class="cw-id-match border-l-2">
            <div class="cw-id-match-label px-3 pt-2 pb-0.5 text-[10px] font-bold uppercase tracking-wider select-none">
              ID match
            </div>
            <SessionRow :id="idMatch" :hide-cwd="false" />
          </div>
          <div
            v-if="idMatch"
            class="border-b border-[var(--cw-border)] "
          ></div>
          <div
            v-if="rankedResults.length || !idMatch"
            class="px-3 pt-2 pb-1 text-xs uppercase tracking-wider opacity-60 select-none"
          >
            {{ rankedResults.length }}{{ rankedResults.length >= 100 ? '+' : '' }} result{{ rankedResults.length === 1 ? '' : 's' }}
            <span v-if="contentSearchInflight" class="opacity-60"> · searching…</span>
          </div>
          <div v-if="rankedResults.length === 0 && !idMatch && !contentSearchInflight" class="px-3 py-3 text-sm opacity-60">
            No matches.
          </div>
          <div
            v-for="row in rankedResults"
            :key="'s-' + row.id"
            @click.capture="onSearchResultCaptureClick(row.id)"
          >
            <SessionRow :id="row.id" :hide-cwd="false" />
          </div>
        </template>
      </div>
    </template>

    <!-- Responsive IM header. Mobile WeChat mirrors the native app with a
         centered title plus Search / Add on the right; Add opens the less
         frequent view/settings actions. Desktop WeChat keeps the efficient
         search-first toolbar, while other skins retain title/count. -->
    <header
      v-else
      class="cw-sidebar-header relative flex items-center border-b border-[var(--cw-border)] shrink-0"
      :class="prefs.messageDisplayStyle === 'wechat'
        ? 'min-h-14 px-3 md:min-h-0 md:gap-2 md:py-2'
        : 'justify-between px-4 py-3'"
    >
      <div
        v-if="prefs.messageDisplayStyle === 'wechat'"
        class="cw-wechat-mobile-home-header relative flex h-14 w-full items-center justify-center md:hidden"
      >
        <h1 class="max-w-[45%] truncate text-[17px] font-semibold leading-none">
          会话<span v-if="totalVisibleUnread > 0">({{ mobileUnreadLabel }})</span>
        </h1>
        <div class="absolute right-0 flex items-center gap-1">
          <button
            type="button"
            class="flex h-9 w-9 items-center justify-center rounded-full opacity-80 active:bg-[var(--cw-panel-2)]"
            title="Search chats"
            aria-label="Search"
            @click="(e) => { openSearch(); (e.currentTarget as HTMLElement).blur(); }"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-[22px] w-[22px]">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <button
            type="button"
            class="flex h-9 w-9 items-center justify-center rounded-full opacity-80 active:bg-[var(--cw-panel-2)]"
            :aria-expanded="mobileHeaderMenuOpen"
            aria-controls="cw-mobile-header-menu"
            title="More actions"
            aria-label="More actions"
            @click="mobileHeaderMenuOpen = !mobileHeaderMenuOpen"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-6 w-6">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
        <button
          v-if="mobileHeaderMenuOpen"
          type="button"
          class="fixed inset-0 z-[60] cursor-default bg-transparent"
          aria-label="Close home actions"
          @click="mobileHeaderMenuOpen = false"
        />
        <div
          v-if="mobileHeaderMenuOpen"
          id="cw-mobile-header-menu"
          class="absolute right-0 top-[calc(100%_-_0.25rem)] z-[61] min-w-44 overflow-hidden rounded-lg border border-[var(--cw-border)] bg-[var(--cw-panel-bg)] py-1 text-sm shadow-xl"
          role="menu"
        >
          <button
            type="button"
            class="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-[var(--cw-panel-2)]"
            role="menuitem"
            @click="showNew = true; mobileHeaderMenuOpen = false"
          >新建会话</button>
          <button
            type="button"
            class="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-[var(--cw-panel-2)]"
            role="menuitem"
            @click="flatMode = !flatMode; mobileHeaderMenuOpen = false"
          >{{ flatMode ? "按文件夹分组" : "按最近排序" }}</button>
          <button
            type="button"
            class="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-[var(--cw-panel-2)]"
            role="menuitem"
            @click="showSettings = true; mobileHeaderMenuOpen = false"
          >设置</button>
        </div>
      </div>
      <div v-if="prefs.messageDisplayStyle !== 'wechat'" class="min-w-0">
        <h1 class="text-lg font-bold leading-tight">Chats</h1>
        <div class="text-[11px] opacity-60 leading-tight whitespace-nowrap overflow-hidden text-ellipsis">
          {{ sessions.list.length }} total<span v-if="pinnedSessionIds.length"> · {{ pinnedSessionIds.length }} pinned</span>
          <span v-if="sessions.syncInFlight > 0" class="cw-sidebar-syncing inline-flex items-center gap-1 ml-1">
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
            <span>Syncing…</span>
          </span>
        </div>
      </div>
      <div
        class="flex items-center gap-1"
        :class="prefs.messageDisplayStyle === 'wechat' ? 'hidden flex-1 min-w-0 md:flex' : ''"
      >
        <button
          @click="(e) => { toggleSearch(); (e.currentTarget as HTMLElement).blur(); }"
          class="cw-sidebar-search-trigger h-9 flex items-center transition focus:outline-none"
          :class="[
            prefs.messageDisplayStyle === 'wechat'
              ? 'flex-1 min-w-0 justify-start gap-2 rounded-md px-3 bg-[var(--cw-control-bg)] text-[var(--cw-muted)]'
              : 'w-9 rounded-full justify-center opacity-70 [@media(hover:hover)]:hover:opacity-100 [@media(hover:hover)]:hover:bg-[var(--cw-panel-2)] ',
            searchOpen ? '!bg-[var(--cw-panel-2)]' : '',
          ]"
          :title="searchOpen ? 'Close search' : 'Search chats'"
          aria-label="Search"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span
            v-if="prefs.messageDisplayStyle === 'wechat'"
            class="truncate text-sm"
          >搜索</span>
        </button>
        <button
          @click="(e) => { flatMode = !flatMode; (e.currentTarget as HTMLElement).blur(); }"
          class="w-9 h-9 rounded-full flex items-center justify-center opacity-70 [@media(hover:hover)]:hover:opacity-100 [@media(hover:hover)]:hover:bg-[var(--cw-panel-2)]  transition focus:outline-none"
          :title="flatMode ? 'Switch to grouped view (by folder)' : 'Switch to flat view (by recency)'"
          :aria-label="flatMode ? 'Switch to grouped view' : 'Switch to flat view'"
        >
          <!-- Flat-mode icon: three horizontal lines (a flat list). -->
          <svg v-if="flatMode" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
          </svg>
          <!-- Grouped-mode icon: indented list (a tree). -->
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="10" y1="12" x2="20" y2="12" />
            <line x1="10" y1="18" x2="20" y2="18" />
          </svg>
        </button>
        <button
          @click="(e) => { showNew = true; (e.currentTarget as HTMLElement).blur(); }"
          class="w-9 h-9 rounded-full flex items-center justify-center opacity-70 [@media(hover:hover)]:hover:opacity-100 [@media(hover:hover)]:hover:bg-[var(--cw-panel-2)]  transition focus:outline-none"
          title="New chat in another folder"
          aria-label="New chat"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          @click="(e) => { showSettings = true; (e.currentTarget as HTMLElement).blur(); }"
          class="w-9 h-9 rounded-full flex items-center justify-center opacity-70 [@media(hover:hover)]:hover:opacity-100 [@media(hover:hover)]:hover:bg-[var(--cw-panel-2)]  transition focus:outline-none"
          title="Settings"
          aria-label="Settings"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
    <!-- Chat list. Hidden when the WeChat-style search page is open; the
         search view above renders its own focused results list. -->
    <div
      v-if="!searchOpen"
      ref="sidebarScroller"
      class="cw-sidebar-scroller flex-1 overflow-y-auto overflow-x-hidden overscroll-contain min-w-0"
    >
      <!-- Pull-to-refresh indicator. Grows in height as the user drags
           down past scrollTop=0; transition kicks in on release/end so the
           snap-back animates. Pointer-events-none so it never eats taps. -->
      <div
        class="overflow-hidden flex items-end justify-center text-[12px] opacity-70 select-none pointer-events-none"
        :class="pullState === 'pulling' ? '' : 'transition-[height]  ease-out'"
        :style="{ height: pullDistance + 'px' }"
      >
        <div class="flex items-center gap-1.5 pb-2">
          <span
            v-if="pullState === 'refreshing'"
            class="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
          />
          <span v-else>{{ pullDistance >= PULL_THRESHOLD ? '↑' : '↓' }}</span>
          <span>{{ pullIndicatorLabel }}</span>
        </div>
      </div>
        <div v-if="activeSessionIds.length" class="border-b border-[var(--cw-border)]  pb-1.5 mb-1.5">
          <div
            class="flex items-center gap-2 px-3 pt-2 pb-1 text-xs uppercase tracking-wider opacity-60 cursor-pointer select-none"
            @click="toggle('__active__')"
          >
            <span class="flex-1 min-w-0">{{ caret('__active__') }} ● Active ({{ activeSessionIds.length }})</span>
            <span
              v-if="collapsed['__active__'] && runningInIds(activeSessionIds)"
              class="relative shrink-0 flex h-2.5 w-2.5"
              title="Something is running"
            >
              <span class="absolute inline-flex h-full w-full rounded-full bg-[var(--cw-success)] opacity-75 animate-ping" />
              <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-[var(--cw-success)]" />
            </span>
            <span
              v-if="collapsed['__active__'] && unreadInIds(activeSessionIds) > 0"
              class="text-[10px] leading-none font-semibold rounded-full bg-[var(--cw-accent)] text-[var(--cw-accent-text)] px-1.5 py-0.5 min-w-[1.1rem] text-center normal-case"
              :title="`${unreadInIds(activeSessionIds)} unread`"
            >{{ unreadInIds(activeSessionIds) > 99 ? '99+' : unreadInIds(activeSessionIds) }}</span>
          </div>
          <template v-if="!collapsed['__active__']">
            <SessionRow v-for="id in activeSessionIds" :key="'a-' + id" :id="id" :hide-cwd="!flatMode" />
          </template>
        </div>
        <div v-if="pinnedSessionIds.length" class="border-b border-[var(--cw-border)]  pb-1.5 mb-1.5">
          <div
            class="flex items-center gap-2 px-3 pt-2 pb-1 text-xs uppercase tracking-wider opacity-60 cursor-pointer select-none"
            @click="toggle('__pinned__')"
          >
            <span class="flex-1 min-w-0">{{ caret('__pinned__') }} ★ Pinned ({{ pinnedSessionIds.length }})</span>
            <span
              v-if="collapsed['__pinned__'] && runningInIds(pinnedSessionIds)"
              class="relative shrink-0 flex h-2.5 w-2.5"
              title="Something is running"
            >
              <span class="absolute inline-flex h-full w-full rounded-full bg-[var(--cw-success)] opacity-75 animate-ping" />
              <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-[var(--cw-success)]" />
            </span>
            <span
              v-if="collapsed['__pinned__'] && unreadInIds(pinnedSessionIds) > 0"
              class="text-[10px] leading-none font-semibold rounded-full bg-[var(--cw-accent)] text-[var(--cw-accent-text)] px-1.5 py-0.5 min-w-[1.1rem] text-center normal-case"
              :title="`${unreadInIds(pinnedSessionIds)} unread`"
            >{{ unreadInIds(pinnedSessionIds) > 99 ? '99+' : unreadInIds(pinnedSessionIds) }}</span>
          </div>
          <template v-if="!collapsed['__pinned__']">
            <SessionRow v-for="id in pinnedSessionIds" :key="'p-' + id" :id="id" :hide-cwd="!flatMode" />
          </template>
        </div>
        <div v-for="(_group, name) in prefs.groups" :key="name" class="border-b border-[var(--cw-border)]  pb-1.5 mb-1.5">
          <div
            class="flex items-center gap-2 px-3 pt-2 pb-1 text-xs uppercase tracking-wider opacity-60 cursor-pointer select-none"
            @click="toggle(name as unknown as string)"
          >
            <span class="flex-1 min-w-0">{{ caret(name as unknown as string) }} {{ name }} ({{ idsInGroup(name as unknown as string).length }})</span>
            <span
              v-if="collapsed[name as unknown as string] && runningInIds(idsInGroup(name as unknown as string))"
              class="relative shrink-0 flex h-2.5 w-2.5"
              title="Something is running"
            >
              <span class="absolute inline-flex h-full w-full rounded-full bg-[var(--cw-success)] opacity-75 animate-ping" />
              <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-[var(--cw-success)]" />
            </span>
            <span
              v-if="collapsed[name as unknown as string] && unreadInIds(idsInGroup(name as unknown as string)) > 0"
              class="text-[10px] leading-none font-semibold rounded-full bg-[var(--cw-accent)] text-[var(--cw-accent-text)] px-1.5 py-0.5 min-w-[1.1rem] text-center normal-case"
              :title="`${unreadInIds(idsInGroup(name as unknown as string))} unread`"
            >{{ unreadInIds(idsInGroup(name as unknown as string)) > 99 ? '99+' : unreadInIds(idsInGroup(name as unknown as string)) }}</span>
          </div>
          <template v-if="!collapsed[name as unknown as string]">
            <SessionRow v-for="id in idsInGroup(name as unknown as string)" :key="'g-' + name + '-' + id" :id="id" :hide-cwd="!flatMode" />
          </template>
        </div>
        <!-- Flat mode: collapse all the cwd buckets into one recency-ranked
             list, with each row showing its own cwd (since there's no group
             header carrying that context anymore). ungroupedIds is already
             mtime-desc from allIds. orderWithForks keeps parent→child
             indentation intact globally, not just within a cwd bucket. -->
        <template v-if="flatMode">
          <SessionRow
            v-for="row in orderWithForks(ungroupedIds)"
            :key="'flat-' + row.id"
            :id="row.id"
            :depth="row.depth"
            :hide-cwd="false"
          />
        </template>
        <template v-else>
        <div v-for="g in cwdGroups" :key="'cwd-' + g.key">
          <!-- items-start (not -center) so the right-side unread/+ buttons
               stay top-aligned when the path wraps to multiple lines. -->
          <div
            class="group/header flex items-start justify-between gap-2 px-3 pt-3 pb-1 text-xs font-semibold opacity-60 select-none min-w-0"
            :title="g.key"
          >
            <!-- Caret sits in its own shrink-0 column so wrapped path
                 lines hang-indent under the label start (aligned with
                 /ak), not all the way left under the caret. -->
            <button
              class="flex-1 min-w-0 text-left flex items-start gap-1 hover:opacity-100 transition-opacity"
              @click="toggle('cwd:' + g.key)"
            >
              <span class="shrink-0">{{ caret('cwd:' + g.key) }}</span>
              <span class="flex-1 min-w-0 break-all">{{ g.label }}<span class="opacity-60 font-normal"> · {{ g.rows.length }}</span></span>
            </button>
            <span
              v-if="collapsed['cwd:' + g.key] && runningInIds(g.rows.map((r) => r.id))"
              class="relative shrink-0 flex h-2.5 w-2.5 mt-0.5"
              title="Something is running"
            >
              <span class="absolute inline-flex h-full w-full rounded-full bg-[var(--cw-success)] opacity-75 animate-ping" />
              <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-[var(--cw-success)]" />
            </span>
            <span
              v-if="collapsed['cwd:' + g.key] && unreadInIds(g.rows.map((r) => r.id)) > 0"
              class="shrink-0 text-[10px] leading-none font-semibold rounded-full bg-[var(--cw-accent)] text-[var(--cw-accent-text)] px-1.5 py-0.5 min-w-[1.1rem] text-center normal-case"
              :title="`${unreadInIds(g.rows.map((r) => r.id))} unread`"
            >{{ unreadInIds(g.rows.map((r) => r.id)) > 99 ? '99+' : unreadInIds(g.rows.map((r) => r.id)) }}</span>
            <button
              class="shrink-0 w-6 h-6 -mr-1 rounded-full flex items-center justify-center hover:bg-[var(--cw-panel-2)] hover:!opacity-100 transition [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/header:opacity-60 [@media(hover:none)]:opacity-60"
              :title="`New chat in ${g.label}`"
              :aria-label="`New chat in ${g.label}`"
              @click.stop="quickHere(g.key)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          <template v-if="!collapsed['cwd:' + g.key]">
            <SessionRow
              v-for="row in g.rows"
              :key="'u-' + g.key + '-' + row.id"
              :id="row.id"
              :depth="row.depth"
              :hide-cwd="true"
            />
          </template>
        </div>
        </template>
    </div>
    <!-- Drag-resize handle only on desktop — mobile sidebar is full-width
         and isn't horizontally resizable. -->
    <div
      class="hidden md:block absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-[color-mix(in_srgb,var(--cw-accent)_50%,transparent)] active:bg-[color-mix(in_srgb,var(--cw-accent)_70%,transparent)]"
      :class="dragging ? 'bg-[color-mix(in_srgb,var(--cw-accent)_70%,transparent)]' : ''"
      @mousedown="onResizeMouseDown"
      title="Drag to resize"
    />
    <NewSessionModal v-if="showNew" @close="showNew = false" />
    <SettingsModal v-if="showSettings" @close="showSettings = false" />
  </aside>
</template>
