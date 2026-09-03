import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sidebar = readFileSync(join(process.cwd(), "src/components/Sidebar.vue"), "utf8");
const sessionRow = readFileSync(join(process.cwd(), "src/components/SessionRow.vue"), "utf8");
const css = readFileSync(join(process.cwd(), "src/styles/tailwind.css"), "utf8");

describe("WeChat sidebar parity", () => {
  it("uses the supplied current-WeChat selection color and full-row treatment", () => {
    expect(css).toContain("--cw-wechat-selection: #0da869");
    expect(css).toMatch(
      /\.cw-app-shell\.cw-shell-wechat \.cw-session-row-selected,[\s\S]*?background:\s*var\(--cw-wechat-selection\)\s*!important;/,
    );
    expect(css).toContain(
      ".cw-app-shell.cw-shell-wechat .cw-session-row-selected .cw-session-selected-strip",
    );
    expect(css).toContain("display: none;");
    expect(css).toContain("var(--cw-wechat-selection-title)");
    expect(css).toContain("var(--cw-wechat-selection-muted)");
  });

  it("defaults to the flat list while preserving the grouped toggle", () => {
    expect(sidebar).toContain('const FLAT_MODE_KEY = "cw:sidebar-flat-mode-v2"');
    expect(sidebar).toContain("return saved === null ? true : saved ===");
    expect(sidebar).toContain("flatMode = !flatMode");
    expect(sidebar).toContain("Switch to grouped view");
  });

  it("uses the softer WeChat gray hierarchy and text-column dividers", () => {
    expect(sessionRow).not.toContain("AgentBadge");
    expect(css).toContain("--cw-shell-bg: #1e1e1f");
    expect(css).toContain("--cw-panel-bg: #2f2f30");
    expect(css).toContain("--cw-control-bg: #3a3a3b");
    expect(sessionRow).toContain("'--cw-session-divider-left'");
    expect(css).toContain("left: var(--cw-session-divider-left, 68px)");
    expect(css).toContain(".cw-session-row-selected::after");
    expect(css).toMatch(
      /\.cw-app-shell\.cw-shell-wechat \.cw-session-running-dot\s*\{\s*display:\s*flex;/,
    );
    expect(css).toMatch(
      /\.cw-app-shell\.cw-shell-wechat \.cw-session-unread\s*\{[\s\S]*?display:\s*flex;[\s\S]*?background:\s*#fa5151\s*!important;/,
    );
  });

  it("uses native mobile and search-first desktop headers in the WeChat skin", () => {
    expect(sidebar).toContain("cw-wechat-mobile-home-header");
    expect(sidebar).toContain('会话<span v-if="totalVisibleUnread > 0">');
    expect(sidebar).toContain("mobileUnreadLabel");
    expect(sidebar).toContain('aria-controls="cw-mobile-header-menu"');
    expect(sidebar).toContain(">新建会话</button>");
    expect(sidebar).toContain('flatMode ? "按文件夹分组" : "按最近排序"');
    expect(sidebar).toContain(">设置</button>");
    expect(sidebar).toContain("'hidden flex-1 min-w-0 md:flex'");
    expect(sidebar).toContain("cw-sidebar-search-trigger");
    expect(sidebar).toContain(">搜索</span>");
    expect(sidebar).not.toContain("搜索聊天");
    expect(css).toMatch(
      /\.cw-app-shell\.cw-shell-wechat \.cw-sidebar \.cw-sidebar-search-trigger\s*\{[\s\S]*?color:\s*var\(--cw-muted\)\s*!important;/,
    );
    expect(sidebar).toContain("prefs.messageDisplayStyle !== 'wechat'");
  });

  it("pins time to the top-right and keeps the WeChat title to one line", () => {
    expect(sessionRow).toContain("cw-session-heading-row");
    expect(sessionRow).toContain("cw-session-time");
    expect(css).toMatch(
      /\.cw-app-shell\.cw-shell-wechat \.cw-session-time\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*14px;[\s\S]*?right:\s*12px;/,
    );
    expect(css).toMatch(
      /\.cw-app-shell\.cw-shell-wechat \.cw-session-title \.line-clamp-2\s*\{[\s\S]*?-webkit-line-clamp:\s*1;/,
    );
  });

  it("keeps Tab navigation and makes WeChat arrows global outside arrow-owning controls", () => {
    expect(sidebar).toContain('e.key !== "Tab"');
    expect(sidebar).toContain("switchSession(e.shiftKey ? -1 : 1)");
    expect(sidebar).toContain('e.key === "ArrowUp" || e.key === "ArrowDown"');
    expect(sidebar).toContain('prefs.messageDisplayStyle === "wechat"');
    expect(sidebar).toContain("if (isComposerTextarea(e.target))");
    expect(sidebar).toContain("if (!isSingleVisualLine(e.target)) return");
    expect(sidebar).toContain("shouldPreserveSessionArrowKey(e.target)");
    expect(sidebar).toContain("hasOpenSessionNavBlockingSurface()");
    expect(sidebar).toContain('left: "-10000px"');
    expect(sidebar).toContain("textarea.clientWidth - paddingLeft - paddingRight");
    expect(sidebar).toContain("renderedHeight <= lineHeight * 1.45");
    expect(sidebar).toContain("const navigationSessionIds = computed(buildNavigationSessionIds)");
    expect(sidebar).toContain("primeMessageTimeline");
  });
});
