import { describe, expect, it } from "vitest";
import {
  fallbackTopicSummary,
  fallbackTitleEmoji,
  normalizeGeneratedSessionTitle,
  normalizeTopicSummary,
  SESSION_TITLE_MODEL,
  SESSION_TITLE_REASONING_EFFORT,
} from "../src/services/session-title-generator.js";

describe("Codex session title generation", () => {
  it("uses the requested lightweight 5.3 Codex model", () => {
    expect(SESSION_TITLE_MODEL).toBe("gpt-5.3-codex-spark");
    expect(SESSION_TITLE_REASONING_EFFORT).toBe("low");
  });

  it("normalizes structured output and keeps one emoji grapheme", () => {
    expect(normalizeGeneratedSessionTitle(
      { title: "修复自动命名 🧰", emoji: "🛠️", summary: "  改进长对话的自动命名。  " },
      "修复自动命名",
    )).toEqual({
      title: "修复自动命名",
      emoji: "🛠️",
      summary: "改进长对话的自动命名。",
    });
    expect(normalizeGeneratedSessionTitle(
      { title: "家庭旅行", emoji: "👨‍👩‍👧‍👦", summary: "规划家庭旅行住宿和交通。" },
      "家庭旅行",
    )).toEqual({
      title: "家庭旅行",
      emoji: "👨‍👩‍👧‍👦",
      summary: "规划家庭旅行住宿和交通。",
    });
  });

  it("falls back to a relevant deterministic emoji for malformed model emoji", () => {
    expect(normalizeGeneratedSessionTitle(
      {
        title: "Debug WebSocket reconnects",
        emoji: "not emoji",
        summary: "Diagnose WebSocket reconnect failures.",
      },
      "Fix a reconnect bug",
    )).toEqual({
      title: "Debug WebSocket reconnects",
      emoji: "🛠️",
      summary: "Diagnose WebSocket reconnect failures.",
    });
    expect(fallbackTitleEmoji("搜索小红书旅行建议")).toBe("🔎");
    expect(fallbackTitleEmoji("ordinary conversation")).toBe("💬");
  });

  it("keeps rolling topic summaries compact and incrementally falls back", () => {
    expect(normalizeTopicSummary("  修复\n 自动标题  ")).toBe("修复 自动标题");
    expect(fallbackTopicSummary("改进 WebUI。", "增加递增主题摘要。"))
      .toContain("改进 WebUI。");
    expect(fallbackTopicSummary("改进 WebUI。", "增加递增主题摘要。"))
      .toContain("增加递增主题摘要。");
  });
});
