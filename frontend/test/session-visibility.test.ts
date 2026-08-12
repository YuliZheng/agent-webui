import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@claude-webui/shared/api";
import {
  isOrdinarySidebarSessionVisible,
  shouldNotifyForSession,
} from "../src/util/session-visibility.js";

const basePrefs = {
  hidden: [] as string[],
  showPeerSessions: false,
  showSubagentSessions: false,
};

function session(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: "session-id",
    cwd: "C:\\repo",
    mtime: "2026-07-26T00:00:00.000Z",
    size: 1,
    agent: "codex",
    ...overrides,
  };
}

describe("ordinary sidebar session visibility", () => {
  it("hides subagent workers by default but preserves direct selection", () => {
    const worker = session({ id: "worker", subagent: true, parentSessionId: "root" });
    expect(isOrdinarySidebarSessionVisible(worker, basePrefs)).toBe(false);
    expect(isOrdinarySidebarSessionVisible(worker, basePrefs, "worker")).toBe(true);
  });

  it("shows subagents when explicitly enabled", () => {
    const worker = session({ subagent: true, parentSessionId: "root" });
    expect(isOrdinarySidebarSessionVisible(worker, {
      ...basePrefs,
      showSubagentSessions: true,
    })).toBe(true);
  });

  it("does not mistake an ordinary fork for a subagent", () => {
    const fork = session({ id: "fork", parentSessionId: "root" });
    expect(isOrdinarySidebarSessionVisible(fork, basePrefs)).toBe(true);
  });

  it("continues to honor manual hidden and peer filters", () => {
    expect(isOrdinarySidebarSessionVisible(session({ id: "hidden" }), {
      ...basePrefs,
      hidden: ["hidden"],
    }, "hidden")).toBe(false);
    expect(isOrdinarySidebarSessionVisible(session({ peer: true }), basePrefs)).toBe(false);
  });
});

describe("session completion notification visibility", () => {
  it("suppresses hidden subagent completion bubbles by default", () => {
    expect(shouldNotifyForSession({
      id: "worker",
      subagent: true,
    }, basePrefs)).toBe(false);
  });

  it("allows subagent completion bubbles only when workers are shown", () => {
    expect(shouldNotifyForSession({
      id: "worker",
      subagent: true,
    }, {
      ...basePrefs,
      showSubagentSessions: true,
    })).toBe(true);
  });

  it("keeps ordinary and forked session completion bubbles", () => {
    expect(shouldNotifyForSession({ id: "ordinary" }, basePrefs)).toBe(true);
    expect(shouldNotifyForSession({ id: "fork" }, basePrefs)).toBe(true);
  });

  it("continues to suppress manually hidden and disabled peer sessions", () => {
    expect(shouldNotifyForSession({ id: "hidden" }, {
      ...basePrefs,
      hidden: ["hidden"],
    })).toBe(false);
    expect(shouldNotifyForSession({
      id: "peer",
      peer: true,
    }, basePrefs)).toBe(false);
  });
});
