import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@claude-webui/shared/api";
import { isOrdinarySidebarSessionVisible } from "../src/util/session-visibility.js";

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
