import { describe, expect, it } from "vitest";
import { EMPTY_PREFS } from "@claude-webui/shared/prefs";
import { adaptBackendPrefs, adaptFrontendPrefs } from "../src/api/prefs.js";

describe("preferences compatibility adapter", () => {
  it("maps the backend schema into the reference frontend schema", () => {
    const adapted = adaptBackendPrefs({
      version: 1,
      hiddenSessionIds: ["hidden", "hidden"],
      groups: [{
        id: "g-work",
        name: "Work",
        sessionIds: ["s1"],
        collapsed: true,
      }],
      pinnedGroupIds: ["g-work"],
      pinnedSessionIds: ["s2"],
      thinkingTrigger: "think hard",
      autoTitleEnabled: true,
      autoTitleFrequency: 7,
      autoTitleLanguage: "简体中文",
      scratchSessionEnabled: false,
      scratchSessionPath: "C:\\scratch",
      defaultClaudeModel: "claude-opus-4-8",
      defaultClaudePermissionMode: "bypassPermissions",
      defaultCodexModel: "gpt-5.6-sol",
      defaultCodexServiceTier: "priority",
      defaultCodexApprovalPreset: "untrusted",
      defaultCodexSandboxMode: "workspace-write",
      showActiveSection: false,
      showPeerSessions: true,
      showSubagentSessions: true,
      messageDisplayStyle: "wechat",
    });

    expect(adapted).toEqual({
      ...EMPTY_PREFS,
      hidden: ["hidden"],
      groups: { Work: { sessions: ["s1"] } },
      pinned: [
        { kind: "group", name: "Work" },
        { kind: "session", id: "s2" },
      ],
      thinkingTrigger: "think hard",
      autoRetitleEnabled: true,
      autoRetitleEvery: 7,
      titleLanguage: "简体中文",
      scratchEnabled: false,
      scratchDir: "C:\\scratch",
      defaultModel: "claude-opus-4-8",
      defaultPermissionMode: "bypassPermissions",
      defaultCodexModel: "gpt-5.6-sol",
      defaultCodexServiceTier: "priority",
      defaultCodexApproval: "auto",
      showActiveSection: false,
      showPeerSessions: true,
      showSubagentSessions: true,
      messageDisplayStyle: "wechat",
    });
  });

  it("round-trips edits while preserving backend-only fields and group identity", () => {
    const current = adaptBackendPrefs({
      version: 1,
      backendOnly: { keep: true },
      hiddenSessionIds: [],
      groups: [{
        id: "existing-id",
        name: "Work",
        sessionIds: ["old"],
        collapsed: true,
      }],
      pinnedGroupIds: [],
      pinnedSessionIds: [],
      defaultCodexSandboxMode: "read-only",
    });

    const outgoing = adaptFrontendPrefs({
      ...current,
      hidden: ["hidden"],
      groups: { Work: { sessions: ["new"] } },
      pinned: [
        { kind: "group", name: "Work" },
        { kind: "session", id: "s2" },
      ],
      defaultPermissionMode: "default",
      defaultCodexServiceTier: "priority",
      defaultCodexApproval: "full-access",
      showSubagentSessions: true,
    });

    expect(outgoing.backendOnly).toEqual({ keep: true });
    expect(outgoing.groups).toEqual([{
      id: "existing-id",
      name: "Work",
      sessionIds: ["new"],
      collapsed: true,
    }]);
    expect(outgoing.hiddenSessionIds).toEqual(["hidden"]);
    expect(outgoing.pinnedGroupIds).toEqual(["existing-id"]);
    expect(outgoing.pinnedSessionIds).toEqual(["s2"]);
    expect(outgoing.defaultClaudePermissionMode).toBe("");
    expect(outgoing.defaultCodexServiceTier).toBe("priority");
    expect(outgoing.defaultCodexApprovalPreset).toBe("never");
    expect(outgoing.defaultCodexSandboxMode).toBe("danger-full-access");
    expect(outgoing.showSubagentSessions).toBe(true);
  });
});
