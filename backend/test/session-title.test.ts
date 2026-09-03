import { describe, expect, it } from "vitest";
import {
  formatTitleWithEmoji,
  normalizeCanonicalTitle,
  normalizeTitleEmoji,
  resolveSessionTitle,
  splitTitleEmoji,
} from "../src/services/session-title.js";

describe("session title precedence", () => {
  it("keeps a WebUI manual title above the shared Codex thread name", () => {
    expect(resolveSessionTitle(
      "codex",
      { title: "WebUI override", source: "manual" },
      "Shared thread name",
    )).toEqual({ title: "WebUI override", source: "manual" });
  });

  it("keeps a WebUI auto title above a different Codex thread name", () => {
    expect(resolveSessionTitle(
      "codex",
      { title: "WebUI auto title", source: "auto" },
      "Canonical Codex title",
    )).toEqual({ title: "WebUI auto title", source: "auto" });
  });

  it("retains local auto titles for Claude and Codex threads", () => {
    const local = { title: "Local title", source: "auto" } as const;
    expect(resolveSessionTitle("claude", local, "Ignored Codex title")).toEqual({
      title: "Local title",
      source: "auto",
    });
    expect(resolveSessionTitle("codex", local, null)).toEqual({
      title: "Local title",
      source: "auto",
    });
  });

  it("uses the Codex thread name when no local title exists", () => {
    expect(resolveSessionTitle("codex", undefined, "Canonical Codex title")).toEqual({
      title: "Canonical Codex title",
      source: "auto",
    });
  });

  it("normalizes whitespace and bounds canonical names", () => {
    expect(normalizeCanonicalTitle("  one \n two  ")).toBe("one two");
    expect(normalizeCanonicalTitle("x".repeat(140))).toHaveLength(120);
    expect(normalizeCanonicalTitle(" \t ")).toBeNull();
  });

  it("splits one complete trailing emoji grapheme without damaging the title", () => {
    expect(splitTitleEmoji("修复自动命名 🛠️")).toEqual({
      title: "修复自动命名",
      emoji: "🛠️",
    });
    expect(splitTitleEmoji("Family plan 👨‍👩‍👧‍👦")).toEqual({
      title: "Family plan",
      emoji: "👨‍👩‍👧‍👦",
    });
    expect(splitTitleEmoji("Japan trip 🇯🇵")).toEqual({
      title: "Japan trip",
      emoji: "🇯🇵",
    });
    expect(splitTitleEmoji("Version 5.3")).toEqual({
      title: "Version 5.3",
      emoji: null,
    });
  });

  it("keeps canonical names composed and local emoji metadata intact", () => {
    expect(formatTitleWithEmoji("修复自动命名", "🛠️")).toBe("修复自动命名 🛠️");
    expect(normalizeTitleEmoji("🛠️")).toBe("🛠️");
    expect(normalizeTitleEmoji("ab")).toBeNull();
    expect(resolveSessionTitle(
      "codex",
      { title: "Local fallback", source: "auto", emoji: "💬" },
      "修复自动命名 🛠️",
    )).toEqual({
      title: "Local fallback",
      source: "auto",
      emoji: "💬",
    });
  });
});
