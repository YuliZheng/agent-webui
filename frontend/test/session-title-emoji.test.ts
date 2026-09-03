import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSessionsStore } from "../src/stores/sessions.js";
import {
  flagEmojiAssetKey,
  sessionTitleEmojiForDisplay,
} from "../src/util/session-title-emoji.js";

const sessionRow = readFileSync(
  join(process.cwd(), "src/components/SessionRow.vue"),
  "utf8",
);
const mainPane = readFileSync(
  join(process.cwd(), "src/components/MainPane.vue"),
  "utf8",
);
const emojiGlyph = readFileSync(
  join(process.cwd(), "src/components/EmojiGlyph.vue"),
  "utf8",
);

describe("session title emoji presentation", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("stores clean title and emoji independently, including explicit clearing", () => {
    const sessions = useSessionsStore();
    const row = {
      id: "session",
      cwd: "C:\\repo",
      mtime: "2026-07-26T00:00:00.000Z",
      size: 1,
      agent: "codex" as const,
      title: null,
    };
    sessions.list = [row];
    sessions.byId = { session: row };

    sessions.setTitle("session", "修复自动命名", "auto", "🛠️");
    expect(sessions.byId.session).toMatchObject({
      title: "修复自动命名",
      titleSource: "auto",
      titleEmoji: "🛠️",
    });

    sessions.setTitle("session", "手动名称", "manual", null);
    expect(sessions.byId.session).toMatchObject({
      title: "手动名称",
      titleSource: "manual",
      titleEmoji: null,
    });
  });

  it("uses the emoji as the row avatar but keeps it in non-sidebar titles", () => {
    expect(sessionRow).toContain("titleEmoji.value || avatarText");
    expect(sessionRow).toContain("avatarIsEmoji");
    expect(sessionRow).toContain("<EmojiGlyph");
    expect(sessionRow).toContain("{{ title }}");
    expect(mainPane).toContain("const displayTitle = computed");
    expect(mainPane).toContain("<SessionTitleText");
    expect(emojiGlyph).toContain("@twemoji/svg/1f1*.svg");
    expect(emojiGlyph).toContain("cw-emoji-glyph inline-flex");
    expect(emojiGlyph).toContain("cw-emoji-glyph-system");
    expect(emojiGlyph).not.toContain("transform: translate(");
  });

  it("renders country flags from Twemoji assets instead of Windows letter fallbacks", () => {
    expect(flagEmojiAssetKey("🇨🇭")).toBe("1f1e8-1f1ed");
    expect(flagEmojiAssetKey("🏔️")).toBeNull();
  });

  it("fills missing emoji only for auto-managed titles", () => {
    expect(sessionTitleEmojiForDisplay("瑞士行程与交通", null, "auto")).toBe("✈️");
    expect(sessionTitleEmojiForDisplay("修复页面错误", "✨", "auto")).toBe("✨");
    expect(sessionTitleEmojiForDisplay("手动标题", null, "manual")).toBeNull();
  });
});
