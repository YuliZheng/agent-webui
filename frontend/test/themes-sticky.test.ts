import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { normalizePrefs, THEME_OPTIONS } from "@/stores/preferences";
import { CLAUDE_CODE_STICKY_GAP_PX } from "@/util/sticky";

const css = readFileSync(join(process.cwd(), "src/styles/index.css"), "utf8");
const component = readFileSync(join(process.cwd(), "src/components/StickyPromptOverlay.vue"), "utf8");
describe("themes and sticky prompt invariants", () => {
  it("offers exactly WeChat and Claude Code", () => expect(THEME_OPTIONS.map((item) => item.value)).toEqual(["wechat", "claude-code"]));
  it("round-trips the server colorPreference wire field", () => {
    const prefs = normalizePrefs({ colorPreference: "dark", messageDisplayStyle: "wechat" });
    expect(prefs.colorPreference).toBe("dark"); expect(prefs).not.toHaveProperty("colorScheme");
  });
  it("keeps the synchronized 12px overlay clone in a clipping frame", () => {
    expect(CLAUDE_CODE_STICKY_GAP_PX).toBe(12);
    expect(css).toMatch(/\.cw-sticky-prompt-overlay-frame\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?overflow:\s*hidden;[\s\S]*?pointer-events:\s*none;/);
    expect(css).toMatch(/\.cw-sticky-prompt-overlay\s*\{[\s\S]*?padding:\s*12px clamp\(16px, 2vw, 42px\) 8px;[\s\S]*?pointer-events:\s*none;/);
    expect(css).toMatch(/\.cw-sticky-prompt-overlay \.cw-user-prompt-toggle\s*\{\s*pointer-events:\s*auto;/);
    expect(component).toContain("preview hide-actions");
  });
  it("gates hover and never makes the real prompt row sticky", () => {
    expect(css).toContain("@media (hover: hover)");
    const rowRules = [...css.matchAll(/\.cw-user-prompt-row[^\{]*\{([^}]*)\}/g)].map((match) => match[1]).join("\n");
    expect(rowRules).not.toMatch(/position\s*:\s*sticky/);
    expect(rowRules).not.toMatch(/transform\s*:/);
  });
  it("keeps the transcript touch-scrollable and the visible mobile pane interactive", () => {
    expect(css).toMatch(/\.cw-transcript-scroll\s*\{[^}]*overflow-y:\s*auto;[^}]*touch-action:\s*pan-y;/s);
    expect(css).toMatch(/\.cw-composer\s*\{[^}]*pointer-events:\s*auto;/s);
    expect(css).toMatch(/\.cw-sidebar\s*\{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s);
    expect(css).toMatch(/\.cw-app\.cw-show-list \.cw-main\s*\{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s);
  });
});
