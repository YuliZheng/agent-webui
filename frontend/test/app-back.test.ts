import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_BACK_PRIORITY,
  dispatchAppBack,
  registerAppBackHandler,
} from "../src/util/app-back.js";
import {
  handlePwaPopState,
  initializeAppHistory,
  setPwaLayerActive,
  standaloneExternalNavigationHref,
  updateHistoryForSelection,
} from "../src/util/pwa-history.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  vi.unstubAllGlobals();
});

function useStandaloneDisplayMode() {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === "(display-mode: standalone)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

describe("PWA external links", () => {
  const base = "https://lggram.tail6c8b6c.ts.net/?session=test";

  it("identifies external web links that need an explicit PWA new-tab open", () => {
    expect(standaloneExternalNavigationHref("https://x.com/openai/status/1", base, true))
      .toBe("https://x.com/openai/status/1");
  });

  it("leaves browser tabs, same-origin links, and non-web schemes alone", () => {
    expect(standaloneExternalNavigationHref("https://x.com/openai", base, false)).toBeNull();
    expect(standaloneExternalNavigationHref("/api/me", base, true)).toBeNull();
    expect(standaloneExternalNavigationHref("javascript:alert(1)", base, true)).toBeNull();
  });

  it("opens PWA external links in a new tab", () => {
    const messageList = readFileSync(join(process.cwd(), "src/components/MessageList.vue"), "utf8");
    expect(messageList).toContain("standaloneExternalNavigationHref(href, window.location.href)");
    expect(messageList).toContain('window.open(external, "_blank", "noopener,noreferrer")');
    expect(messageList).not.toContain("window.location.assign(external)");
  });
});

describe("PWA app back hierarchy", () => {
  it("offers back to the topmost active layer before the fallback", () => {
    const calls: string[] = [];
    cleanups.push(registerAppBackHandler(() => {
      calls.push("menu");
      return true;
    }, APP_BACK_PRIORITY.menu));
    cleanups.push(registerAppBackHandler(() => {
      calls.push("overlay");
      return true;
    }, APP_BACK_PRIORITY.overlay));

    expect(dispatchAppBack(() => {
      calls.push("fallback");
      return true;
    })).toBe(true);
    expect(calls).toEqual(["overlay"]);
  });

  it("keeps one conversation level instead of a chain of visited chats", () => {
    useStandaloneDisplayMode();
    window.history.replaceState({}, "", "/");
    initializeAppHistory(null);
    updateHistoryForSelection("session-a", null);
    const lengthAfterOpen = window.history.length;
    updateHistoryForSelection("session-b", "session-a");

    expect(window.history.state).toMatchObject({
      agentWebUi: true,
      sessionId: "session-b",
    });
    expect(window.history.length).toBe(lengthAfterOpen);
  });

  it("closes a visible layer and restores the current conversation", () => {
    useStandaloneDisplayMode();
    window.history.replaceState(
      { agentWebUi: true, sessionId: null },
      "",
      "/",
    );
    cleanups.push(registerAppBackHandler(() => true, APP_BACK_PRIORITY.sheet));

    const result = handlePwaPopState(
      "session-a",
      { agentWebUi: true, sessionId: null },
      () => dispatchAppBack(),
    );

    expect(result).toEqual({ handled: true });
    expect(window.history.state).toMatchObject({
      agentWebUi: true,
      sessionId: "session-a",
    });
  });

  it("returns a conversation to the list when no inner layer handles back", () => {
    useStandaloneDisplayMode();
    const result = handlePwaPopState(
      "session-a",
      { agentWebUi: true, sessionId: null },
      () => false,
    );
    expect(result).toEqual({ handled: true, selection: null });
  });

  it("supports consecutive detail → conversation → list back gestures", () => {
    useStandaloneDisplayMode();
    window.history.replaceState({}, "", "/");
    initializeAppHistory(null);
    updateHistoryForSelection("session-a", null);
    setPwaLayerActive("session-status", true, "session-a");
    let detailOpen = true;
    cleanups.push(registerAppBackHandler(() => {
      if (!detailOpen) return false;
      detailOpen = false;
      setPwaLayerActive("session-status", false, "session-a");
      return true;
    }, APP_BACK_PRIORITY.sheet));

    // Chrome has already traversed from the explicit detail entry to the
    // conversation entry before delivering popstate.
    window.history.replaceState(
      { agentWebUi: true, sessionId: "session-a" },
      "",
      "/?session=session-a",
    );
    expect(handlePwaPopState(
      "session-a",
      window.history.state,
      () => dispatchAppBack(),
    )).toEqual({ handled: true });
    expect(detailOpen).toBe(false);
    expect(window.history.state).toMatchObject({ sessionId: "session-a" });

    // The next gesture reaches home; no layer consumes it, so selection clears.
    window.history.replaceState(
      { agentWebUi: true, sessionId: null },
      "",
      "/",
    );
    expect(handlePwaPopState(
      "session-a",
      window.history.state,
      () => dispatchAppBack(),
    )).toEqual({ handled: true, selection: null });
  });

  it("gives a list-level modal its own temporary back entry", () => {
    useStandaloneDisplayMode();
    window.history.replaceState({}, "", "/");
    initializeAppHistory(null);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});

    setPwaLayerActive("sidebar-overlay", true, null);
    expect(window.history.state).toMatchObject({
      agentWebUi: true,
      sessionId: null,
      layer: "sidebar-overlay",
    });
    setPwaLayerActive("sidebar-overlay", false, null);
    expect(back).toHaveBeenCalledOnce();

    // Consume the programmatic history.back marker so it cannot leak into a
    // later real user back action.
    expect(handlePwaPopState(null, { agentWebUi: true, sessionId: null }, () => false))
      .toEqual({ handled: true });
    back.mockRestore();
  });

  it("leaves ordinary browser tabs on their existing session-history model", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    window.history.replaceState({}, "", "/");
    initializeAppHistory(null);
    updateHistoryForSelection("session-a", null);
    updateHistoryForSelection("session-b", "session-a");
    expect(window.history.state).toEqual({ sessionId: "session-b" });
  });

  it("wires major WebUI layers into standalone-PWA popstate handling", () => {
    const app = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");
    const status = readFileSync(join(process.cwd(), "src/components/SessionStatusPage.vue"), "utf8");
    const sidebar = readFileSync(join(process.cwd(), "src/components/Sidebar.vue"), "utf8");
    const lightbox = readFileSync(join(process.cwd(), "src/components/Lightbox.vue"), "utf8");

    expect(app).toContain("handlePwaPopState");
    expect(app).toContain("dispatchAppBack");
    expect(status).toContain("APP_BACK_PRIORITY.sheet");
    expect(sidebar).toContain("handleAppBack");
    expect(sidebar).toContain('setPwaLayerActive("sidebar-overlay"');
    expect(lightbox).toContain("APP_BACK_PRIORITY.overlay");
  });
});
