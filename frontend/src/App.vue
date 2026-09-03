<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Sidebar from "./components/Sidebar.vue";
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

// The chat surface pulls in MessageList, Markdown/KaTeX, the composer and the
// preview stack. CSS `display: none` still downloaded and parsed that entire
// graph on the mobile home screen, even though only the session list is
// visible there. Keep desktop's two-pane layout, but defer the chat graph on a
// narrow viewport until the user actually opens a conversation.
const MainPane = defineAsyncComponent(() => import("./components/MainPane.vue"));
const desktopViewport = ref(
  typeof window === "undefined"
  || typeof window.matchMedia !== "function"
  || window.matchMedia("(min-width: 768px)").matches,
);
const shouldMountMainPane = computed(() => desktopViewport.value || Boolean(ui.selectedSessionId));
let desktopViewportQuery: MediaQueryList | null = null;

function syncDesktopViewport(e: MediaQueryList | MediaQueryListEvent) {
  desktopViewport.value = e.matches;
}

onMounted(() => {
  if (typeof window.matchMedia !== "function") return;
  desktopViewportQuery = window.matchMedia("(min-width: 768px)");
  syncDesktopViewport(desktopViewportQuery);
  desktopViewportQuery.addEventListener?.("change", syncDesktopViewport);
});

onBeforeUnmount(() => {
  desktopViewportQuery?.removeEventListener?.("change", syncDesktopViewport);
});

const fatalError = ref<string | null>(null);
const fatalAuthError = computed(() => /(?:unauthori[sz]ed|forbidden|\b401\b|\b403\b|token)/i.test(fatalError.value ?? ""));
const appShellClass = computed(() => `cw-app-shell cw-shell-${prefs.messageDisplayStyle}`);

function reloadApp() {
  window.location.reload();
}

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

function onServiceWorkerMessage(event: MessageEvent) {
  const data = event.data as { kind?: unknown; sessionId?: unknown } | null;
  if (data?.kind !== "open-session" || typeof data.sessionId !== "string" || !data.sessionId) return;
  ui.select(data.sessionId);
  // `select()` intentionally no-ops when this conversation was already
  // selected. A notification click still means the background unread is now
  // seen, so settle it explicitly in that case too.
  sessions.markRead(data.sessionId);
}

onMounted(() => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
  }
});

onBeforeUnmount(() => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.removeEventListener("message", onServiceWorkerMessage);
  }
});

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
    else if (sessions.loaded) void sessions.fetchAll();
    else tasks.push(sessions.fetchAll());
    if (boot.prefs) prefs.hydrate(adaptBackendPrefs(boot.prefs));
    else tasks.push(prefs.load());
    if (boot.me) { me = boot.me; }
    else { me = await getMe(); }
    await Promise.all(tasks);
    ui.setHome(me.home);
    // History wiring: restore selection from URL on first load, replace the
    // initial history entry so it carries a sessionId state, and listen for
    // popstate (mouse-back / mobile back-gesture) to switch sessions.
    const initialId = initialSessionFromUrl();
    if (initialId) ui.selectFromHistory(initialId);
    initializeAppHistory(initialId);
    window.addEventListener("popstate", onPopState);

    // Let a deep-linked session mount and engage its history before spending
    // disk/CPU on background tail warming. Idle callback keeps cold-index work
    // out of the critical first paint; the timeout fallback covers Safari.
    const warmRecentTails = () => { void live.prefetchTails(); };
    const idleWindow = window as typeof window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
    if (idleWindow.requestIdleCallback) idleWindow.requestIdleCallback(warmRecentTails, { timeout: 1500 });
    else window.setTimeout(warmRecentTails, 250);

    // Re-pull the sessions list to re-anchor preview / lastTurnAt /
    // lastBoundaryAt — only `notification` events have a replay buffer
    // server-side, so any session-touched / session-renamed that fired
    // while we were offline would otherwise be lost and the sidebar
    // rows would stay frozen on stale previews until something writes
    // again. Debounced 5s so rapid focus-toggle / unlock spam doesn't
    // hammer the API.
    let lastResyncAt = 0;
    let resyncWork: Promise<boolean> | null = null;
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
    // Global WS pushes already keep an open home list current. A full list for
    // a large archive is hundreds of KiB, so use this only as a quiet missed-
    // event safety net instead of downloading it twice per minute.
    const ACTIVE_SYNC_INTERVAL_MS = 8_000;
    const HOME_SYNC_INTERVAL_MS = 120_000;
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
        // HTTP catch-up is independent of the rebuilt socket and closes any
        // final gap immediately. Force this reconnect snapshot because the
        // previous successful tail may still be inside its normal freshness
        // window even though the disconnected interval lost new records.
        void live.refreshEngaged(true);
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
      //   (3) the active chat content — mobile lifecycle events are not
      //       reliable enough to infer whether bytes were missed from hidden
      //       duration alone. A short app switch can freeze/drop the socket
      //       without crossing LONG_SUSPEND_MS. Always perform one small HTTP
      //       tail catch-up for the open chat on foreground; it never rebuilds
      //       the WS subscription. The retry sweep only repeats after failure.
      let refreshedTail = false;
      let refreshTailWork: Promise<void> | null = null;
      const tryRefreshTail = () => {
        if (refreshedTail || refreshTailWork) return;
        const sid = ui.selectedSessionId;
        if (!sid || sessions.isPending(sid)) {
          refreshedTail = true;
          return;
        }
        // The selected chat is the user-visible source of truth. Refresh it
        // directly even if a lifecycle/MainPane race has not yet recreated its
        // per-session WS subscription; idle sessions can still have a final
        // assistant batch that the suspended phone missed.
        refreshTailWork = live.refreshSession(sid, true)
          .then(() => { refreshedTail = true; })
          .finally(() => { refreshTailWork = null; });
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
      const hasLocallyRunningSession = Object.values(sessions.statusBySession)
        .some(status => status === "running")
        || Object.values(sessions.compactingBySession).some(Boolean);
      const minGap = hasLocallyRunningSession ? ACTIVE_SYNC_INTERVAL_MS : HOME_SYNC_INTERVAL_MS;
      if (!force && now - lastHomeSyncAt < minGap) return;
      lastHomeSyncAt = now;
      resyncSessions(true);
    }

    function reconcileVisibleActivity() {
      if (document.visibilityState === "hidden") return;
      const sid = ui.selectedSessionId;
      if (!sid) {
        syncHomeIfVisible();
        return;
      }
      if (
        sessions.statusBySession[sid] !== "running"
        && sessions.compactingBySession[sid] !== true
      ) return;
      if (sessions.isPending(sid)) return;
      void live.reconcileRunningSession(sid).catch(error => {
        console.warn(`[live] running-session reconciliation failed for ${sid}: ${(error as Error).message}`);
      });
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
    window.setInterval(reconcileVisibleActivity, ACTIVE_SYNC_INTERVAL_MS);
  } catch (err) {
    fatalError.value = (err as Error).message;
  }
});
</script>

<template>
  <div v-if="fatalError" class="flex h-full items-start justify-center bg-[var(--cw-shell-bg)] px-5 pt-[18vh] text-[var(--cw-text)]" role="alert">
    <div class="w-full max-w-sm rounded-xl bg-[var(--cw-panel-bg)] p-5 shadow-lg">
      <h1 class="text-lg font-semibold">暂时无法打开 Agent WebUI</h1>
      <p class="mt-2 text-sm leading-6 text-[var(--cw-muted)]">
        {{ fatalAuthError
          ? "当前地址的访问凭据无效，请重新打开正确的入口。"
          : "请检查工作资料里的 Tailscale 和 Tailnet Relay，然后再试一次。" }}
      </p>
      <button
        type="button"
        class="mt-4 min-h-11 w-full rounded-lg bg-[var(--cw-accent)] px-4 text-sm font-medium text-[var(--cw-accent-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cw-accent)]"
        @click="reloadApp"
      >
        重新加载
      </button>
      <details class="mt-3 text-xs text-[var(--cw-muted)]">
        <summary class="cursor-pointer py-1">查看错误详情</summary>
        <pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--cw-panel-2)] p-3">{{ fatalError }}</pre>
      </details>
    </div>
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
      v-if="shouldMountMainPane"
      :class="ui.selectedSessionId
        ? 'flex-1 flex flex-col min-w-0'
        : 'hidden md:flex md:flex-col md:flex-1 md:min-w-0'"
    />
    <ToastStack />
    <Lightbox />
  </div>
</template>
