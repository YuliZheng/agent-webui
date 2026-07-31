import { describe, expect, it } from "vitest";
import {
  createDefaultPrefs,
  isPrefsBlob,
  MESSAGE_DISPLAY_STYLE_OPTIONS,
  normalizeMessageDisplayStyle,
  normalizePrefs,
} from "../src/prefs.js";

describe("preference normalization", () => {
  it("provides independent fresh defaults", () => {
    const first = createDefaultPrefs();
    const second = createDefaultPrefs();
    first.hiddenSessionIds.push("abc");
    expect(second.hiddenSessionIds).toEqual([]);
    expect(second.messageDisplayStyle).toBe("claude-code");
    expect(second.colorPreference).toBe("system");
    expect(second.showSubagentSessions).toBe(false);
  });

  it("allows exactly the two display styles", () => {
    expect(MESSAGE_DISPLAY_STYLE_OPTIONS.map((option) => option.value)).toEqual([
      "wechat",
      "claude-code",
    ]);
    expect(normalizeMessageDisplayStyle("wechat")).toBe("wechat");
    expect(normalizeMessageDisplayStyle("claude-code")).toBe("claude-code");
    expect(normalizeMessageDisplayStyle("claude")).toBe("wechat");
    expect(normalizeMessageDisplayStyle("legacy-style")).toBe("wechat");
    expect(normalizeMessageDisplayStyle(null)).toBe("wechat");
  });

  it("normalizes valid fields, identifiers and ordering", () => {
    const prefs = normalizePrefs({
      hiddenSessionIds: ["one", "bad/id", "one", 2],
      groups: [
        {
          id: "work",
          name: " Work ",
          sessionIds: ["one", "two", "one", "../escape"],
          collapsed: true,
        },
        { id: "work", name: "duplicate", sessionIds: [] },
        { id: "bad/id", name: "bad", sessionIds: [] },
      ],
      pinnedGroupIds: ["work"],
      pinnedSessionIds: ["two", "one"],
      thinkingTrigger: "ultrathink",
      autoCompactWindow: 180_000,
      codexAutoCompactWindow: 350_000,
      autoTitleEnabled: false,
      autoTitleFrequency: 12,
      autoTitleLanguage: "zh-CN",
      scratchSessionEnabled: true,
      scratchSessionPath: "C:\\scratch",
      defaultClaudeModel: "opus",
      defaultClaudePermissionMode: "plan",
      defaultCodexModel: "gpt-5",
      defaultCodexServiceTier: "priority",
      defaultCodexApprovalPreset: "on-request",
      showActiveSection: false,
      showPeerSessions: false,
      showSubagentSessions: true,
      messageDisplayStyle: "wechat",
      colorPreference: "dark",
    });

    expect(prefs.hiddenSessionIds).toEqual(["one"]);
    expect(prefs.groups).toEqual([
      {
        id: "work",
        name: "Work",
        sessionIds: ["one", "two"],
        collapsed: true,
      },
    ]);
    expect(prefs.pinnedSessionIds).toEqual(["two", "one"]);
    expect(prefs.autoCompactWindow).toBe(180_000);
    expect(prefs.codexAutoCompactWindow).toBe(350_000);
    expect(prefs.autoTitleFrequency).toBe(12);
    expect(prefs.defaultCodexServiceTier).toBe("priority");
    expect(prefs.showSubagentSessions).toBe(true);
    expect(prefs.messageDisplayStyle).toBe("wechat");
    expect(prefs.colorPreference).toBe("dark");
  });

  it("falls back safely and strips unknown legacy feature fields", () => {
    const prefs = normalizePrefs({
      messageDisplayStyle: "bubble",
      colorPreference: "sepia",
      autoTitleFrequency: 0,
      legacySecret: "secret",
      legacyEnabled: true,
      legacyDraft: "binary",
      legacyService: "old-service",
      legacyRemote: true,
    });

    expect(prefs.messageDisplayStyle).toBe("wechat");
    expect(prefs.colorPreference).toBe("system");
    expect(prefs.autoTitleFrequency).toBe(5);
    expect(prefs.defaultCodexServiceTier).toBe("");
    expect(prefs.autoCompactWindow).toBeNull();
    expect(prefs.codexAutoCompactWindow).toBeNull();
    expect(Object.keys(prefs)).not.toContain("legacySecret");
    expect(Object.keys(prefs)).not.toContain("legacyDraft");
    expect(Object.keys(prefs)).not.toContain("legacyRemote");
  });

  it("accepts only the priority Codex service-tier default", () => {
    expect(normalizePrefs({ defaultCodexServiceTier: "priority" }).defaultCodexServiceTier).toBe("priority");
    expect(normalizePrefs({ defaultCodexServiceTier: "fast" }).defaultCodexServiceTier).toBe("");
    expect(normalizePrefs({ defaultCodexServiceTier: "standard" }).defaultCodexServiceTier).toBe("");
  });

  it("accepts only positive integer compact windows", () => {
    expect(normalizePrefs({ autoCompactWindow: 180_000 }).autoCompactWindow).toBe(180_000);
    expect(normalizePrefs({ codexAutoCompactWindow: 350_000 }).codexAutoCompactWindow).toBe(350_000);
    for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY, "350000"]) {
      expect(normalizePrefs({ autoCompactWindow: value }).autoCompactWindow).toBeNull();
      expect(normalizePrefs({ codexAutoCompactWindow: value }).codexAutoCompactWindow).toBeNull();
    }
  });

  it("validates canonical blobs", () => {
    const canonical = normalizePrefs({ messageDisplayStyle: "wechat" });
    expect(isPrefsBlob(canonical)).toBe(true);
    expect(isPrefsBlob({ ...canonical, messageDisplayStyle: "legacy-style" })).toBe(
      false,
    );
    expect(isPrefsBlob({ ...canonical, legacyEnabled: true })).toBe(false);
    expect(isPrefsBlob(null)).toBe(false);
  });
});
