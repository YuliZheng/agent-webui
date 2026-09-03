import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appVue = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");
const sidebarVue = readFileSync(join(process.cwd(), "src/components/Sidebar.vue"), "utf8");
const sessionsStore = readFileSync(join(process.cwd(), "src/stores/sessions.ts"), "utf8");
const liveStore = readFileSync(join(process.cwd(), "src/stores/live.ts"), "utf8");
const messageListVue = readFileSync(join(process.cwd(), "src/components/MessageList.vue"), "utf8");

describe("mobile resume recovery", () => {
  it("force-reconnects and retries resync after long mobile suspend", () => {
    expect(appVue).toContain("const LONG_SUSPEND_MS = 60_000");
    expect(appVue).toContain("const RESUME_RETRY_DELAYS_MS = [0, 500, 1_500, 5_000, 15_000] as const");
    expect(appVue).toContain("const ACTIVE_SYNC_INTERVAL_MS = 8_000");
    expect(appVue).toContain("const HOME_SYNC_INTERVAL_MS = 120_000");
    expect(appVue).toContain("function resumePass(forceReconnect: boolean, tryRefreshTail: () => void)");
    expect(appVue).toContain("wsWake({ forceReconnect })");
    expect(appVue).toContain("if (forceReconnect) sessions.clearAllStatus()");
    expect(appVue).toContain("resyncSessions(true)");
    // The active chat must catch up on every foreground sweep. HTTP is
    // independent of the WebSocket and live.ts freshness-coalesces successful
    // retries, so a short app switch cannot leave the open transcript stale.
    expect(appVue).toContain("const tryRefreshTail = () =>");
    expect(appVue).toContain("const sid = ui.selectedSessionId");
    expect(appVue).toContain("live.refreshSession(sid, true)");
    expect(appVue).toContain("sessions.isPending(sid)");
    expect(appVue).toContain("if (refreshedTail || refreshTailWork) return");
    expect(appVue).not.toContain("const shouldRefreshTail = longSuspend || hiddenMs >= LONG_SUSPEND_MS");
    expect(appVue).not.toContain("!wsConnected.value");
  });

  it("only treats inactivity as suspend when timers actually froze (desktop fix)", () => {
    // Desktop tabs stay focused for hours; gesture-gap alone must NOT force
    // a WS teardown. A real suspend freezes setInterval — that's the signal.
    expect(appVue).toContain("const SUSPEND_TICK_MS = 5_000");
    expect(appVue).toContain("const SUSPEND_GAP_MS = 90_000");
    expect(appVue).toContain("function timersWereFrozen(now: number): boolean");
    expect(appVue).toContain("&& timersWereFrozen(now))");
    expect(appVue).toContain("if (longGestureGap && timersWereFrozen(now)) resumeVisible(true)");
  });

  it("has lifecycle and user-gesture fallbacks for iOS unlock paths", () => {
    expect(appVue).toContain("let hiddenAt: number | null = null");
    expect(appVue).toContain("let lastForceResumeAt = 0");
    expect(appVue).toContain("let lastUserGestureAt = Date.now()");
    expect(appVue).toContain("now - lastUserGestureAt >= LONG_SUSPEND_MS");
    expect(appVue).toContain("function maybeResumeFromUserGesture()");
    expect(appVue).toContain("resumeVisible(true)");
    expect(appVue).toContain("window.addEventListener(\"pointerdown\", maybeResumeFromUserGesture");
    expect(appVue).toContain("window.addEventListener(\"touchstart\", maybeResumeFromUserGesture");
    expect(appVue).toContain("document.visibilityState === \"hidden\"");
    expect(appVue).toContain("hiddenAt = Date.now()");
  });

  it("polls the visible mobile home list so missed lifecycle events still refresh chats", () => {
    expect(appVue).toContain("function syncHomeIfVisible(force = false)");
    expect(appVue).toContain("if (document.visibilityState === \"hidden\") return");
    expect(appVue).toContain("if (ui.selectedSessionId) return");
    expect(appVue).toContain("resyncSessions(true)");
    expect(appVue).toContain("window.setInterval(reconcileVisibleActivity, ACTIVE_SYNC_INTERVAL_MS)");
  });

  it("reconciles a visibly stuck running session without waiting for a reconnect", () => {
    expect(appVue).toContain("function reconcileVisibleActivity()");
    expect(appVue).toContain("live.reconcileRunningSession(sid)");
    expect(appVue).toContain("window.setInterval(reconcileVisibleActivity, ACTIVE_SYNC_INTERVAL_MS)");
    expect(liveStore).toContain("reconcileRunningSession(id: string): Promise<void>");
    expect(liveStore).toContain('ENGAGE_HTTP_TAIL_N, true, "interactive", false');
    expect(liveStore).toContain('sessions.setStatus(id, "exited", false, false)');
  });

  it("paints cached chats before refreshing a large archive in the background", () => {
    expect(sessionsStore).toContain('const SESSION_LIST_STORAGE_KEY = "cw:sessions:v1"');
    expect(sessionsStore).toContain("loaded: cachedItems.length > 0");
    expect(appVue).toContain("else if (sessions.loaded) void sessions.fetchAll()");
    expect(sidebarVue).toContain("eligibleVisibleIds.value.slice(0, visibleSessionLimit.value)");
    expect(sidebarVue).toContain("Show older conversations");
  });

  it("syncs EVERY session tail over coalesced HTTP before waiting for WS subscribe", () => {
    // HTTP tail must run for all agents (not codex-only): on mobile resume the
    // WS can be a zombie (OPEN but dead) and a WS subscribe goes nowhere, so a
    // claude session would show stale cache until a full reload. The HTTP GET
    // paints the latest lines regardless of socket health.
    expect(liveStore).toContain("readSessionTail,");
    expect(sessionsStore).toContain("markReadRemote(id, at)");
    expect(liveStore).toContain("const ENGAGE_TAIL_N = 200");
    // engage() fetches a small tail on tap through the public retry API…
    expect(liveStore).toContain("this.refreshSession(id)");
    // …which shares in-flight work and a short successful-result window.
    expect(liveStore).toContain("const existing = tailFetchWork.get(id)");
    expect(liveStore).toContain("const TAIL_FRESH_MS = 20_000");
    // readSessionTail + cache reconciliation remain in the shared helper.
    expect(liveStore).toContain("const tail = await readSessionTail(id, n, priority)");
    expect(liveStore).toContain("cache.appendBatch(id, items)");
    // Guard against regressing to the codex-only gate.
    expect(liveStore).not.toContain("?.agent === \"codex\"");
  });

  it("warms recent session tails via background prefetch", () => {
    expect(liveStore).toContain("async prefetchTails(");
    expect(liveStore).toContain("fetchTailIntoCache(id, PREFETCH_TAIL_N, false, \"background\")");
    expect(liveStore).toContain("for (const id of ids) void cache.restore(id)");
    expect(liveStore).toContain("if (sessions.list.length > MAX_NETWORK_PREFETCH_SESSION_COUNT) return");
    // Prefetch is wired into boot, reconnect, resume, and the home-list poll.
    expect(appVue).toContain("live.prefetchTails()");
    // A deep link must engage the selected chat before idle background work can
    // occupy the backend's serialized cold-index reader.
    expect(appVue.indexOf("ui.selectFromHistory(initialId)")).toBeLessThan(appVue.indexOf("const warmRecentTails"));
    expect(appVue).toContain("requestIdleCallback");
  });

  it("starts the local cache before network sync without blocking either path", () => {
    const engageStart = liveStore.indexOf("async engage(id: string)");
    const engageEnd = liveStore.indexOf("refreshSession(id: string", engageStart);
    const body = liveStore.slice(engageStart, engageEnd);
    expect(body.indexOf("void cache.restore(id)")).toBeGreaterThan(-1);
    expect(body.indexOf("void cache.restore(id)")).toBeLessThan(body.indexOf("this.subscribeToSession(id"));
    expect(body.indexOf("void cache.restore(id)")).toBeLessThan(body.indexOf("this.refreshSession(id)"));
  });

  it("flags an in-flight on-tap tail fetch so the chat shows a syncing pill", () => {
    expect(liveStore).toContain("tailFetching: Record<string, boolean>");
    expect(liveStore).toContain("tailErrors: Record<string, string | undefined>");
    expect(liveStore).toContain("this.tailFetching[id] = true");
    expect(liveStore).toContain("this.tailFetching[id] = false");
    expect(liveStore).toContain("refreshSession(id: string, force = false): Promise<void>");
    expect(messageListVue).toContain("live.tailFetching[props.sessionId]");
  });

  it("uses HTTP catch-up instead of rebuilding a healthy per-session tail", () => {
    const refreshStart = liveStore.indexOf("refreshEngaged(force = false)");
    const handlerStart = liveStore.indexOf("onSessionMsg(", refreshStart);
    const body = liveStore.slice(refreshStart, handlerStart);
    expect(body).toContain("this.refreshSession(id, force)");
    expect(body).not.toContain("this.disengage(id)");
    expect(body).not.toContain("subscribe(\"session\"");
  });

  it("uses the same non-destructive HTTP fallback for the stale-stream watchdog", () => {
    const watchdogStart = liveStore.indexOf("// Desync watchdog");
    const watchdogEnd = liveStore.indexOf('} else if (kind === "session-renamed")', watchdogStart);
    const body = liveStore.slice(watchdogStart, watchdogEnd);
    expect(body).toContain("this.refreshSession(id, true)");
    expect(body).toContain("STALE_STREAM_HTTP_MIN_GAP_MS");
    expect(body).toContain("staleStreamHttpAt.set(id, now)");
    expect(body).not.toContain("this.disengage(id)");
    expect(body).not.toContain("this.subscribeToSession(id");
  });

  it("surfaces a sidebar syncing state while resume HTTP refreshes are running", () => {
    expect(sessionsStore).toContain("syncInFlight: number");
    expect(sessionsStore).toContain("this.syncInFlight++");
    expect(sessionsStore).toContain("this.syncInFlight = Math.max(0, this.syncInFlight - 1)");
    expect(sidebarVue).toContain("cw-sidebar-syncing");
    expect(sidebarVue).toContain("sessions.syncInFlight > 0");
    expect(sidebarVue).toContain("Syncing…");
  });

  it("hydrates the homepage from the post-scan refresh snapshot", () => {
    const refreshStart = sidebarVue.indexOf("async function runPullRefresh()");
    const refreshEnd = sidebarVue.indexOf("onMounted(() =>", refreshStart);
    const body = sidebarVue.slice(refreshStart, refreshEnd);
    expect(body).toContain("const refreshed = await refreshBackend()");
    expect(body).toContain("sessions.hydrateList(refreshed.sessions, startedAtRevision)");
    expect(body).not.toContain("sessions.fetchAll()");
    expect(body).not.toContain("forceReconnect");
  });

  it("keeps pull-to-refresh on the session list without hiding it in the transcript", () => {
    expect(sidebarVue).toContain("// ─── Pull-to-refresh on the sidebar");
    expect(sidebarVue).toContain("async function runPullRefresh()");
    expect(messageListVue).not.toContain("onPullTouchStart");
    expect(messageListVue).not.toContain("pullIndicatorLabel");
    expect(messageListVue).toContain('loadEarlierError || "加载更早记录"');
  });
});
