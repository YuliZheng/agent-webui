import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePrefs, THEME_OPTIONS } from "@/stores/preferences";

const read = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8");
const app = read("src/App.vue");
const composer = read("src/components/ComposerBar.vue");
const sidebar = read("src/components/Sidebar.vue");
const row = read("src/components/SessionRow.vue");

describe("reference shell theme contract", () => {
  it("keeps exactly the two styles and falls unknown values back to WeChat", () => {
    expect(THEME_OPTIONS.map((option) => option.value)).toEqual([
      "wechat",
      "claude-code",
    ]);
    expect(
      normalizePrefs({ messageDisplayStyle: "unknown" as never })
        .messageDisplayStyle,
    ).toBe("wechat");
  });

  it("mounts the style on html and the matching skin on the application shell", () => {
    expect(app).toContain(
      "const appShellClass = computed(() => `cw-app-shell cw-shell-${prefs.messageDisplayStyle}`)",
    );
    expect(app).toContain("document.documentElement.classList.add(lastStyleClass)");
    expect(app).toContain("document.documentElement.dataset.messageDisplayStyle = style");
    expect(app).toContain('class="cw-main cw-main-pane"');
  });

  it("provides the exact semantic shell hooks used by both themes", () => {
    for (const hook of [
      "cw-sidebar",
      "cw-sidebar-header",
      "cw-sidebar-search-page-header",
      "cw-sidebar-search-input",
      "cw-sidebar-scroller",
      "cw-context-menu",
    ]) {
      expect(sidebar).toContain(hook);
    }
    for (const hook of [
      "cw-session-row-selected",
      "cw-session-selected-strip",
      "cw-session-time",
      "cw-session-cwd",
      "cw-session-unread",
      "cw-session-running-dot",
    ]) {
      expect(row).toContain(hook);
    }
  });

  it("keeps attachments and sending in both composer structures without voice UI", () => {
    for (const hook of [
      "cw-prompt-input",
      "cw-image-draft-strip",
      "cw-composer-row",
      "cw-composer-textarea",
      "cw-attach-button",
      "cw-send-button",
      "cw-cc-composer",
      "cw-cc-textarea",
      "cw-cc-toolbar",
      "cw-cc-send",
      "--cw-wechat-composer-height",
      "发送(S)",
    ]) {
      expect(composer).toContain(hook);
    }
    expect(composer).not.toMatch(/\bcw-(?:mic|voice)/);
    expect(composer).not.toMatch(/\bmicrophone\b/i);
  });
});
