<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Sidebar from "./components/Sidebar.vue";
import MainPane from "./components/MainPane.vue";
import ToastStack from "./components/ToastStack.vue";
import Lightbox from "./components/Lightbox.vue";
import { useSessionsStore } from "./stores/sessions.js";
import { usePrefsStore } from "./stores/prefs.js";
import { useLiveStore } from "./stores/live.js";
import { useUiStore } from "./stores/ui.js";
import { useSessionCacheStore } from "./stores/session-cache.js";
import { connect as wsConnect, connected as wsConnected, wake as wsWake } from "./api/ws.js";
import { applyTheme, syncThemeColor } from "./util/theme.js";
import { getMe } from "./api/me.js";
import { adaptBackendPrefs } from "./api/prefs.js";
import { isOrdinarySidebarSessionVisible } from "./util/session-visibility.js";
import { dispatchAppBack } from "./util/app-back.js";
import { handlePwaPopState, initializeAppHistory } from "./util/pwa-history.js";

const sessions = useSessionsStore();
const prefs = usePrefsStore();
const live = useLiveStore();
const ui = useUiStore();
const cache = useSessionCacheStore();

const fatalError = ref<string | null>(null);
const appShellClass = computed(() => `cw-app-shell cw-shell-${prefs.messageDisplayStyle}`);

// Taskbar/dock unread badge for the installed PWA. The Badging API paints
// navigator.setAppBadge(n) onto the app icon (a number on Windows, a dot on
// some platforms); clearAppBadge() removes it. Foreground-only is enough here
// — no service worker needed — we just mirror the total unread count whenever
// it changes. Guarded with optional-call so plain browser tabs (no Badging
// support) are a no-op.
// Only count unread for sessions the user can actually see in the sidebar —
// mirror visibleIds there: skip hidden sessions and (unless opted in) peer
// sessions. Otherwise the badge counts archived/hidden chats the user has no
// way to clear, and stays stuck high.
const totalUnread = computed(() => {
  let sum = 0;
  for (const [id, n] of Object.entries(sessions.unreadBySession)) {
    if (!n) continue;
    // Only count sessions still in the list. unreadBySession is persisted in
    // localStorage, so stale ids for deleted/vanished sessions would otherwise
    // inflate the badge above what the sidebar shows (it sums over visibleIds
    // only). Mirrors the sidebar's existence + hidden + peer filtering.
    if (!isOrdinarySidebarSessionVisible(sessions.byId[id], prefs)) continue;
    sum += n;
  }
  return sum;
});
watch(
  totalUnread,
  (n) => {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (n > 0) void nav.setAppBadge?.(n);
    else void nav.clearAppBadge?.();
  },
  { immediate: true },
);

let lastStyleClass = "";
watch(
  () => prefs.messageDisplayStyle,
  (style) => {
    if (typeof document === "undefined") return;
    if (lastStyleClass) document.documentElement.classList.remove(lastStyleClass);
    lastStyleClass = `cw-style-${style}`;
    document.documentElement.classList.add(lastStyleClass);
    document.documentElement.dataset.messageDisplayStyle = style;
    syncThemeColor();
  },
  { immediate: true },
);

function initialSessionFromUrl(): string | null {
  const url = new URL(window.location.href);
  const id = url.searchParams.get("session");
  return id && id.length > 0 ? id : null;
}

function onPopState(e: PopStateEvent) {
  const pwaResult = handlePwaPopState(
    ui.selectedSessionId,
    e.state,
    () => dispatchAppBack(),
  );
  if (pwaResult.handled) {
    if ("selection" in pwaResult) ui.selectFromHistory(pwaResult.selection ?? null);
    return;
  }
  const fromState = (e.state as { sessionId?: string | null } | null)?.sessionId;
  const id = fromState ?? initialSessionFromUrl();
  ui.selectFromHistory(id ?? null);
}

onMounted(async () => {
  try {
    applyTheme(ui.theme);
    wsConnect();
    live.startGlobal();
    // Inline-boot fast path: backend bakes sessions/prefs/me into the HTML
    // as window.__BOOT__, so we skip the get-* RPCs on first load and save
    // ~1 RTT. If any field is missing (boot build failed, older backend,
    // etc.), fall back to RPC for that one only.
    interface Boot { sessions?: import("@claude-webui/shared/api").SessionListItem[] | null; prefs?: unknown; me?: { home: string } | null }
    const boot = (window as unknown as { __BOOT__?: Boot }).__BOOT__ ?? {};
    const tasks: Promise<unknown>[] = [];
    let me: { home: string };
    if (boot.sessions) sessions.hydrateList(boot.sessions);
    else tasks.push(sessions.fetchAll());
    if (boot.prefs) prefs.hydrate(adaptBackendPrefs(boot.prefs));
    else tasks.push(prefs.load());
    if (boot.me) { me = boot.me; }
    else { me = await getMe(); }
    await Promise.all(tasks);
    ui.setHome(me.home);
    // Warm tails for the most-recent sessions so the first tap is instant.
    void live.prefetchTails();

    // History wiring: restore selection from URL on first load, replace the
    // initial history entry so it carries a sessionId state, and listen for
    // popstate (mouse-back / mobile back-gesture) to switch sessions.
    const initialId = initialSessionFromUrl();
    if (initialId) ui.selectFromHistory(initialId);
    initializeAppHistory(initialId);
    window.addEventListener("popstate", onPopState);

    // Re-pull the sessions list to re-anchor preview / lastTurnAt /
    // lastBoundaryAt — only `notification` events have a replay buffer
    // server-side, so any session-touched / session-renamed that fired
    // while we were offline would otherwise be lost and the sidebar
    // rows would stay frozen on stale previews until something writes
    // again. Debounced 5s so rapid focus-toggle / unlock spam doesn't
    // hammer the API.
    let lastResyncAt = 0;
    let resyncWork: Promise<void> | null = null;
    const RESYNC_MIN_GAP_MS = 5000;
    function resyncSessions(force = false) {
      const now = Date.now();
      if (resyncWork) return resyncWork;
      if (!force && now - lastResyncAt < RESYNC_MIN_GAP_MS) return;
      lastResyncAt = now;
      resyncWork = sessions.fetchAll().finally(() => { resyncWork = null; });
      return resyncWork;
    }

    // Mobile lock-screen / proxy recovery is not one clean event. iOS may
    // fire focus/pageshow before the network tunnel is usable, or not fire a
    // visibility event at all until the user touches the page. Treat a long
    // sleep as a small recovery window: force a fresh WS once, then retry the
    // cheap list + active-tail resync as the network comes back.
    const LONG_SUSPEND_MS = 60_000;
    const RESUME_RETRY_DELAYS_MS = [0, 500, 1_500, 5_000, 15_000] as const;
    // Global WebSocket pushes keep the list current. This is only a quiet
    // fallback for missed pushes, not a second real-time transport.
    const HOME_SYNC_INTERVAL_MS = 30_000;
    let hiddenAt: number | null = null;
    let lastResumeSweepAt = Date.now();
    let lastForceResumeAt = 0;
    let lastUserGestureAt = Date.now();
    let lastHomeSyncAt = 0;
    let resumeSweepSeq = 0;

    // Real-suspend detector. The old heuristics (tab hidden ≥60s, or no
    // user gesture ≥60s) were treated as "device slept → force-reconnect".
    // On DESKTOP that misfires constantly: reading a visible tab for a
    // minute without clicking made the next click tear down a perfectly
    // healthy WS (log signature: reconnect-supersede closes with gapAvg≈5s
    // heartbeats), and each teardown + resubscribe burst is a fresh shot at
    // the no-tail race documented in live.ts — the "stops updating until
    // refresh" symptom. A GENUINE suspend (lock screen, lid close, OS
    // sleep) freezes setInterval outright, so a tick gap far beyond the
    // interval is the trustworthy signal. Background-tab throttling only
    // stretches ticks to ~1/min, safely under the 90s threshold. (Chrome
    // can also outright FREEZE a long-hidden tab — that trips the detector
    // too, which is fine: a socket that sat through a page freeze is worth
    // a force-reconnect anyway.)
    const SUSPEND_TICK_MS = 5_000;
    const SUSPEND_GAP_MS = 90_000;
    let lastTickAt = Date.now();
    // Latched (not a time window): a detected freeze stays pending until a
    // long-suspend sweep actually consumes it. iOS can deliver the first
    // user gesture arbitrarily late after wake with no focus/visibility
    // event in between — a fixed "within 30s of the tick" window would
    // expire and the gesture path would never recover the session.
    let suspendPending = false;
    window.setInterval(() => {
      const now = Date.now();
      if (now - lastTickAt >= SUSPEND_GAP_MS) suspendPending = true;
      lastTickAt = now;
    }, SUSPEND_TICK_MS);
    function timersWereFrozen(now: number): boolean {
      // Direct gap check covers resumeVisible running BEFORE the post-wake
      // tick lands; suspendPending covers running any time after it did.
      return now - lastTickAt >= SUSPEND_GAP_MS || suspendPending;
    }

    function resumePass(forceReconnect: boolean, tryRefreshTail: () => void) {
      wsWake({ forceReconnect });
      if (forceReconnect) sessions.clearAllStatus();
      resyncSessions(true);
      if (!forceReconnect) tryRefreshTail();
      // Re-warm recent tails over HTTP — independent of the WS, so it refreshes
      // the cache even while the socket is still healing from a zombie state.
      void live.prefetchTails();
      const sid = ui.selectedSessionId;
      if (sid) sessions.markRead(sid);
    }

    // Reconnect → wipe stale per-session statuses (the backend snapshot that
    // follows only re-asserts non-null statuses, so a session that finished
    // while we were offline would otherwise stay stuck on a stale "running"),
    // re-pull the sessions list, and refresh per-session tail subs so any
    // missed jsonl lines are replayed.
    watch(wsConnected, (now, prev) => {
      if (now && !prev) {
        sessions.clearAllStatus();
        resyncSessions();
        void live.prefetchTails();
        // Force per-session re-subscribe with fresh nextLineIndex. ws.ts
        // auto-re-subscribes after reconnect using the OLD captured `from`,
        // which makes the backend replay the entire session every time. Cheap
        // to fix here: tear down + re-engage anchors on what the cache already
        // has, so backend only streams genuinely new lines.
        void live.refreshEngaged();
      }
    });

    // Persist any dirty cache when the page is hidden / unloaded.
    // pagehide fires more reliably than beforeunload on mobile Safari.
    const flush = () => { void cache.flushAll(); };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    function resumeVisible(forceLongSuspend = false) {
      const now = Date.now();
      const hiddenMs = hiddenAt === null ? 0 : now - hiddenAt;
      // Long-suspend (→ force a brand-new WS) only when timers actually
      // froze — i.e. the OS really suspended the page. Mere inactivity or
      // a backgrounded-but-running tab keeps the existing socket; wake()'s
      // immediate ping plus the ws.ts watchdog cover the zombie case.
      const longSuspend = forceLongSuspend
        || ((hiddenMs >= LONG_SUSPEND_MS || now - lastUserGestureAt >= LONG_SUSPEND_MS) && timersWereFrozen(now));
      // pageshow + focus + visibilitychange often arrive as a burst. Avoid
      // force-reconnecting several times for one unlock, but still allow a
      // long-suspend pointer fallback to run if no lifecycle event fired.
      if (now - lastResumeSweepAt < 2_000 && (!longSuspend || now - lastForceResumeAt < 2_000)) return;
      lastResumeSweepAt = now;
      if (longSuspend) { lastForceResumeAt = now; suspendPending = false; }
      hiddenAt = null;
      const seq = ++resumeSweepSeq;
      // Lock-screen / tab-switch return path. Three things can be stale:
      //   (1) the WebSocket is silently dead — mobile OSes freeze sockets
      //       during suspend without firing close, so live updates would
      //       hang for the next ping interval plus pong timeout before we
      //       even noticed. wsWake() pings or force-reconnects immediately.
      //   (2) the sessions list snapshot — only `notification` events have a
      //       server-side replay buffer, so any session-touched /
      //       session-renamed events that fired while we were hidden are lost.
      //       resyncSessions() re-pulls the list (debounced 5s).
      //   (3) the active chat content — even if (1) finds the socket alive,
      //       events the backend pushed during the OS-frozen window may have
      //       been silently dropped. Force a re-subscribe here so the backend
      //       re-streams from the cache's current nextLineIndex.
      // Tail re-subscribe (live.refreshEngaged) is disruptive — each call
      // tears down + rebuilds the backend tail, and a reorder/drop among
      // those frames can leave the session with NO tail (live.ts watchdog
      // catches it 3s later, but mid-burst it's a real gap). Only do it
      // once per sweep, and only when bytes could actually have been
      // dropped: a genuine suspend froze the page, or the tab spent a long
      // time hidden (mobile OSes drop in-flight WS bytes for backgrounded
      // pages without freezing timers). A visible desktop tab that merely
      // went unclicked gets neither — its socket never lost bytes.
      const shouldRefreshTail = longSuspend || hiddenMs >= LONG_SUSPEND_MS;
      let refreshedTail = false;
      const tryRefreshTail = () => {
        if (!shouldRefreshTail || refreshedTail || !wsConnected.value) return;
        refreshedTail = true;
        void live.refreshEngaged();
      };
      for (const [i, delay] of RESUME_RETRY_DELAYS_MS.entries()) {
        setTimeout(() => {
          if (seq !== resumeSweepSeq) return;
          resumePass(i === 0 && longSuspend, tryRefreshTail);
        }, delay);
      }
    }

    function maybeResumeFromUserGesture() {
      const now = Date.now();
      const longGestureGap = now - lastUserGestureAt >= LONG_SUSPEND_MS;
      lastUserGestureAt = now;
      // Only treat the gesture as a wake-from-suspend when timers actually
      // froze. "Read the page for a minute, then click" used to force a
      // full WS teardown here — the dominant desktop disconnect source.
      if (longGestureGap && timersWereFrozen(now)) resumeVisible(true);
    }

    function syncHomeIfVisible(force = false) {
      if (document.visibilityState === "hidden") return;
      // Mobile home view = chat list with no selected session. If a chat is
      // open, live.refreshEngaged/resumeVisible owns the active transcript.
      if (ui.selectedSessionId) return;
      const now = Date.now();
      if (!force && now - lastHomeSyncAt < HOME_SYNC_INTERVAL_MS) return;
      lastHomeSyncAt = now;
      resyncSessions(true);
    }

    // Network came back (iOS toggles this on cell↔wifi, lock-screen wake on a
    // flaky link, transient blip recovery). Don't wait for reconnect backoff.
    window.addEventListener("online", () => resumeVisible());
    // iOS/Safari does not always fire visibilitychange on app-switch return;
    // pageshow/focus cover BFCache restores and foregrounding paths where the
    // page is visible but the WS module is stale.
    window.addEventListener("pageshow", () => resumeVisible());
    window.addEventListener("focus", () => resumeVisible());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        flush();
      } else if (document.visibilityState === "visible") {
        resumeVisible();
      }
    });
    window.addEventListener("pagehide", () => { hiddenAt = Date.now(); });
    window.addEventListener("pointerdown", maybeResumeFromUserGesture, { capture: true, passive: true });
    window.addEventListener("touchstart", maybeResumeFromUserGesture, { capture: true, passive: true });
    window.setInterval(() => syncHomeIfVisible(), HOME_SYNC_INTERVAL_MS);
  } catch (err) {
    fatalError.value = (err as Error).message;
  }
});
</script>

<template>
  <div v-if="fatalError" class="m-6 text-[var(--cw-danger)]">
    {{ fatalError }} — append <code>?token=&lt;your-token&gt;</code> to the URL and reload.
  </div>
  <!-- IM-style mobile layout: chat list IS the home view. The sidebar takes
       the whole viewport when no session is selected; once a session opens
       (real or pending draft), the main pane covers the sidebar entirely
       and the in-pane back button returns to the list. On md+ both panels
       coexist as before — Telegram Web style. -->
  <div v-else class="flex h-full min-h-0 overflow-hidden" :class="appShellClass">
    <Sidebar
      :class="ui.selectedSessionId
        ? 'hidden md:flex md:flex-col md:w-72 md:shrink-0'
        : 'flex flex-col flex-1 md:flex-none md:w-72 md:shrink-0'"
    />
    <MainPane
      :class="ui.selectedSessionId
        ? 'flex-1 flex flex-col min-w-0'
        : 'hidden md:flex md:flex-col md:flex-1 md:min-w-0'"
    />
    <ToastStack />
    <Lightbox />
  </div>
</template>
