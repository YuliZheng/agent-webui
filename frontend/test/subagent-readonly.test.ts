import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isReadOnlySubagentSession,
  isSessionSearchable,
} from "../src/util/session-access.js";

const mainPane = readFileSync(join(process.cwd(), "src/components/MainPane.vue"), "utf8");
const sessionRow = readFileSync(join(process.cwd(), "src/components/SessionRow.vue"), "utf8");
const sidebar = readFileSync(join(process.cwd(), "src/components/Sidebar.vue"), "utf8");

describe("sub-agent read-only sessions", () => {
  it("distinguishes a worker from an ordinary interactive fork", () => {
    expect(isReadOnlySubagentSession({ subagent: true, parentSessionId: "parent" })).toBe(true);
    expect(isReadOnlySubagentSession({ subagent: false, parentSessionId: "parent" })).toBe(false);
    expect(isReadOnlySubagentSession({})).toBe(false);
    expect(isReadOnlySubagentSession(null)).toBe(false);
  });

  it("hides only sub-agent workers from every sidebar search path", () => {
    expect(isSessionSearchable({ subagent: true, parentSessionId: "parent" })).toBe(false);
    expect(isSessionSearchable({ subagent: false, parentSessionId: "parent" })).toBe(true);
    expect(isSessionSearchable({})).toBe(true);
    expect(sidebar).toContain("if (!isSessionSearchable(sessions.byId[id])) continue;");
    expect(sidebar).toContain("if (!isSessionSearchable(item)) return null;");
  });

  it("replaces the composer with a parent-session recovery action", () => {
    expect(mainPane).toContain('v-if="isReadOnlySubagent"');
    expect(mainPane).toContain('v-else\n        :session-id="sessionId"');
    expect(mainPane).toContain("子 Agent · 只读");
    expect(mainPane).toContain("打开父会话");
    expect(mainPane).toContain("ui.select(subagentParentId.value)");
  });

  it("marks the session row without treating every child fork as read-only", () => {
    expect(sessionRow).toContain('v-if="isReadOnlySubagent"');
    expect(sessionRow).toContain("isReadOnlySubagentSession(item.value)");
    expect(sessionRow).not.toContain("isReadOnlySubagentSession(item.value?.parentSessionId)");
  });
});
