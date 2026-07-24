import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const css = read("src/styles/index.css");
const appVue = read("src/App.vue");
const messageListVue = read("src/components/TranscriptPane.vue");
const userPromptVue = read("src/components/blocks/UserPromptBlock.vue");
const toolBlockVue = read("src/components/blocks/ToolBlock.vue");
const toolResultVue = read("src/components/blocks/ToolResult.vue");
const stickyVue = read("src/components/StickyPromptOverlay.vue");
const parserTs = read("src/parser/index.ts");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectorBlocks(source: string, selector: string): string[] {
  const pattern = new RegExp(`(?:^|})\\s*${escapeRegExp(selector)}\\s*\\{([^{}]*)}`, "g");
  return [...source.matchAll(pattern)].map((match) => match[1] ?? "");
}

function declaration(block: string, property: string): string | undefined {
  const pattern = new RegExp(`${escapeRegExp(property)}\\s*:\\s*([^;]+)\\s*;`, "g");
  return [...block.matchAll(pattern)].at(-1)?.[1]?.trim();
}

const expectedWechatDarkTokens = {
  "--cw-shell-bg": "#111111",
  "--cw-panel-bg": "#1f1f1f",
  "--cw-panel-2": "#333333",
  "--cw-header-bg": "#111111",
  "--cw-border": "#2a2a2a",
  "--cw-border-strong": "#4d4d4d",
  "--cw-text": "#ededed",
  "--cw-muted": "#888888",
  "--cw-control-bg": "#2a2a2a",
  "--cw-control-hover": "#333333",
  "--cw-input-bg": "#111111",
  "--cw-accent": "#1aad19",
  "--cw-accent-text": "#06130d",
  "--cw-composer-bg": "#111111",
  "--cw-wechat-user-bg": "#2ba245",
  "--cw-wechat-user-text": "#07180d",
  "--cw-wechat-peer-bg": "#2f2f2f",
} as const;

function hasCanonicalWechatDarkCascade(source: string): boolean {
  const blocks = selectorBlocks(source, "html.dark.cw-style-wechat");
  if (blocks.length !== 1) return false;
  return Object.entries(expectedWechatDarkTokens).every(
    ([property, expected]) => declaration(blocks[0]!, property) === expected,
  );
}

describe("reference UI contract", () => {
  it("mounts the same theme at html, shell, and message-list levels", () => {
    expect(appVue).toContain("cw-app-shell");
    expect(appVue).toContain("cw-shell-");
    expect(css).toContain("cw-style-wechat");
    expect(css).toContain("cw-display-wechat");
    expect(css).toContain("cw-style-claude-code");
    expect(css).toContain("cw-display-claude-code");
    expect(messageListVue).toContain("cw-message-list");
    expect(messageListVue).toContain("cw-display-");
  });

  it("keeps Claude Code full-width and free of timeline rails", () => {
    expect(css).not.toContain(".cw-display-claude-code .cw-message-scroller::before");
    expect(css).not.toContain(".cw-display-claude-code .cw-message-entry::before");
    expect(css).toMatch(/\.cw-display-claude-code \.cw-message-entry\s*\{[^}]*width:\s*auto;[^}]*max-width:\s*none;[^}]*margin:\s*0 clamp\(16px, 2vw, 42px\) 12px;/s);
    expect(css).toMatch(/\.cw-message-list\.cw-display-claude-code \.cw-user-prompt-wrap\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;/s);
  });

  it("keeps the exact WeChat mirrored-band geometry and dark tokens", () => {
    expect(css).toMatch(/\.cw-display-wechat \.cw-message-entry\s*\{[^}]*width:\s*min\(calc\(100% - clamp\(24px, 4vw, 96px\)\), clamp\(1240px, 86vw, 1920px\)\);[^}]*max-width:\s*none;[^}]*margin:\s*0 auto 9px;/s);
    expect(css).toContain("max-width: calc(100% - 92px)");
    expect(css).toContain("max-width: calc(100% - 84px) !important");
    expect(css).not.toContain("max-width: min(760px, 74%)");
    expect(css).not.toContain("max-width: calc(100% - 48px)");
    expect(hasCanonicalWechatDarkCascade(css)).toBe(true);
    expect(
      hasCanonicalWechatDarkCascade(
        `${css}\nhtml.dark.cw-style-wechat { --cw-shell-bg: #000000; }\n`,
      ),
      "a later duplicate selector must invalidate the cascade contract",
    ).toBe(false);
    expect(css).toContain("--tw-prose-counters: #031008");
    expect(css).not.toContain("html.cw-style-wechat:not(.light)");
  });

  it("does not reintroduce a hard-coded desktop reference pass", () => {
    expect(css).not.toMatch(/#0e0e0e|#191919|#20b85f|#167b88|#29bd6b|#28bd6a/i);
    for (const match of css.matchAll(/@media\s*\(\s*min-width\s*:\s*768px\s*\)\s*\{([\s\S]*?)(?=\n\})/g)) {
      expect(match[1]).not.toMatch(/#0e0e0e|#191919|#20b85f|#167b88|#29bd6b|#28bd6a/i);
    }
  });

  it("keeps WeChat bubble, avatar, prose, image, and fade details", () => {
    expect(css).toContain(".cw-display-wechat .cw-message-avatar");
    expect(css).toContain(".cw-display-wechat .cw-message-avatar-user img");
    expect(css).toContain("border-radius: 6px 2px 6px 6px");
    expect(css).toContain("background: var(--cw-wechat-peer-bg, var(--cw-panel-bg)) !important");
    expect(css).toContain(".cw-display-wechat .cw-user-prompt-image-bubble");
    expect(css).toContain(".cw-display-wechat .cw-user-prompt-image-bubble::after");
    expect(css).toContain(".cw-display-wechat .cw-user-prompt .prose *");
    expect(css).toContain(".cw-display-wechat .cw-user-prompt .prose ol > li::marker");
    expect(css).toContain("linear-gradient(to bottom, transparent, var(--cw-wechat-user-bg");
  });

  it("keeps the exact WeChat composer geometry and never overlays it", () => {
    expect(css).toContain("height: var(--cw-wechat-composer-height, 168px)");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(css).toContain("font-size: 15.5px");
    expect(css).toContain("line-height: 1.65");
    expect(css).toContain("min-width: 76px");
    expect(css).toContain("calc(10px + env(safe-area-inset-bottom))");
    expect(css).toContain(".cw-app-shell.cw-shell-wechat .cw-send-button:disabled");
    expect(messageListVue).toContain("cw-context-notice");
    expect(messageListVue).toContain("contextUsageSnapshot");
    for (const match of css.matchAll(/([^{}]*\.cw-prompt-input[^{}]*)\{([^}]*)\}/g)) {
      expect(match[2], match[1]).not.toMatch(/position\s*:\s*(?:absolute|fixed)/);
    }
  });

  it("implements measured prompt collapse, preview, actions, and touch menu", () => {
    expect(userPromptVue).toContain("Show more");
    expect(userPromptVue).toContain("Show less");
    expect(userPromptVue).toContain("preview?: boolean");
    expect(userPromptVue).toContain("ResizeObserver");
    expect(userPromptVue).toMatch(/54\s*:\s*180|54[^;\n]*180/);
    expect(userPromptVue).toContain("450");
    expect(userPromptVue).toContain("10");
    expect(userPromptVue).toContain('pointerType !== "touch"');
    expect(userPromptVue).toContain("<Teleport");
    expect(css).toContain(".cw-user-prompt-wrap:hover .cw-user-prompt-actions");
    expect(css).toContain("width: max-content");
  });

  it("uses only an overlay clone for Claude Code sticky prompts", () => {
    expect(messageListVue).toContain("stickyPromptUuid");
    expect(messageListVue).toContain("recomputeStickyPrompt");
    expect(messageListVue).toContain("stickyPromptOverlayEntry");
    expect(messageListVue).toContain("cw-user-prompt-anchor");
    expect(messageListVue).toContain('data-user-prompt="true"');
    expect(messageListVue).toContain("CLAUDE_CODE_STICKY_GAP_PX");
    expect(stickyVue).toContain("cw-sticky-prompt-overlay-frame");
    expect(stickyVue).toContain("preview");
    expect(css).toMatch(/\.cw-display-claude-code \.cw-sticky-prompt-overlay-frame\s*\{[^}]*inset:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.cw-display-claude-code \.cw-sticky-prompt-overlay \.cw-user-prompt-toggle\s*\{[^}]*pointer-events:\s*auto;/s);
    expect(css).toMatch(/\.cw-display-claude-code \.cw-sticky-prompt-overlay\s*\{[^}]*top:\s*0;[^}]*padding:\s*12px clamp\(16px, 2vw, 42px\) 8px;/s);
    expect(css).not.toMatch(/\.cw-display-claude-code \.cw-message-entry\[data-block="UserPromptBlock"\]\s*\{[^}]*position:\s*sticky/s);
    expect(css).not.toContain("backdrop-filter: blur(12px)");
  });

  it("implements compact tool rows, two-call runs, and tool-result folding", () => {
    expect(parserTs).toContain("TOOL_RUN_MIN = 2");
    expect(messageListVue).toContain("ToolRunBlock");
    expect(toolBlockVue).toContain("cw-tool-call");
    expect(toolBlockVue).toContain("cw-tool-call-header");
    expect(toolResultVue).toMatch(/lines[^<\n]*>\s*10|>\s*10/);
    expect(toolResultVue).toMatch(/chars[^<\n]*>\s*1000|>\s*1000/);
    expect(css).toContain(':has(> .cw-assistant-block > .cw-tool-call):not(:has(.prose))');
    expect(css).toContain('.cw-message-entry[data-block="ToolRunBlock"]');
    expect(css).toContain(".cw-message-entry:has(.cw-tool-call)::before");
    expect(css).toContain("content: none !important");
  });

  it("keeps the specified render-window and scroll thresholds", () => {
    expect(messageListVue).toContain("INITIAL_RENDER_FAST = 30");
    expect(messageListVue).toContain("INITIAL_RENDER_FULL = 200");
    expect(messageListVue).toContain("RENDER_BATCH = 200");
    expect(messageListVue).toContain("AUTO_LOAD_THRESHOLD_PX = 200");
    expect(messageListVue).toContain("NEAR_BOTTOM_PX = 24");
    expect(css).toMatch(/\.cw-prompt-nav\s*\{[^}]*position:\s*absolute;/s);
    expect(css).toMatch(/@media \(max-width:\s*767px\)[\s\S]*?\.cw-app-shell\.cw-shell-claude-code \.cw-prompt-input:has\(\.cw-cc-composer\)\s*\{[^}]*width:\s*100%;/s);
  });
});
