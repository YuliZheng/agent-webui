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
    expect(appVue).toContain("const HOME_SYNC_INTERVAL_MS = 30_000");
    expect(appVue).toContain("function resumePass(forceReconnect: boolean, tryRefreshTail: () => void)");
    expect(appVue).toContain("wsWake({ forceReconnect })");
    expect(appVue).toContain("if (forceReconnect) sessions.clearAllStatus()");
    expect(appVue).toContain("resyncSessions(true)");
    // Tail re-subscribe is once-per-sweep and gated on suspend/hidden — not
    // fired on every retry pass (each refreshEngaged risks the no-tail race).
    expect(appVue).toContain("const shouldRefreshTail = longSuspend || hiddenMs >= LONG_SUSPEND_MS");
    expect(appVue).toContain("if (!shouldRefreshTail || refreshedTail || !wsConnected.value) return");
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
    expect(appVue).toContain("window.setInterval(() => syncHomeIfVisible(), HOME_SYNC_INTERVAL_MS)");
  });

  it("prefetches EVERY session tail over HTTP before waiting for WS subscribe", () => {
    // HTTP tail must run for all agents (not codex-only): on mobile resume the
    // WS can be a zombie (OPEN but dead) and a WS subscribe goes nowhere, so a
    // claude session would show stale cache until a full reload. The HTTP GET
    // paints the latest lines regardless of socket health.
    expect(liveStore).toContain("import { readSessionTail, markReadRemote } from \"../api/sessions.js\"");
    expect(liveStore).toContain("const ENGAGE_TAIL_N = 200");
    // engage() fetches a small tail on tap via the shared helper…
    expect(liveStore).toContain("this.fetchTailIntoCache(id, ENGAGE_HTTP_TAIL_N)");
    // …which is the only place readSessionTail + appendBatch live now.
    expect(liveStore).toContain("const tail = await readSessionTail(id, n)");
    expect(liveStore).toContain("cache.appendBatch(id, items)");
    // Guard against regressing to the codex-only gate.
    expect(liveStore).not.toContain("?.agent === \"codex\"");
  });

  it("warms recent session tails via background prefetch", () => {
    expect(liveStore).toContain("async prefetchTails(");
    expect(liveStore).toContain("fetchTailIntoCache(id, PREFETCH_TAIL_N)");
    // Prefetch is wired into boot, reconnect, resume, and the home-list poll.
    expect(appVue).toContain("live.prefetchTails()");
  });

  it("flags an in-flight on-tap tail fetch so the chat shows a syncing pill", () => {
    expect(liveStore).toContain("tailFetching: Record<string, boolean>");
    expect(liveStore).toContain("this.tailFetching[id] = true");
    expect(liveStore).toContain("this.tailFetching[id] = false");
    expect(messageListVue).toContain("live.tailFetching[props.sessionId]");
  });

  it("surfaces a sidebar syncing state while resume HTTP refreshes are running", () => {
    expect(sessionsStore).toContain("syncInFlight: number");
    expect(sessionsStore).toContain("this.syncInFlight++");
    expect(sessionsStore).toContain("this.syncInFlight = Math.max(0, this.syncInFlight - 1)");
    expect(sidebarVue).toContain("cw-sidebar-syncing");
    expect(sidebarVue).toContain("sessions.syncInFlight > 0");
    expect(sidebarVue).toContain("Syncing…");
  });
});
