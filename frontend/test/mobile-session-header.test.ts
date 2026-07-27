import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mainPane = readFileSync(join(process.cwd(), "src/components/MainPane.vue"), "utf8");
const statusPage = readFileSync(join(process.cwd(), "src/components/SessionStatusPage.vue"), "utf8");
const assistantBlock = readFileSync(join(process.cwd(), "src/components/blocks/AssistantBlock.vue"), "utf8");
const localCommands = readFileSync(join(process.cwd(), "src/util/local-commands.ts"), "utf8");
const css = readFileSync(join(process.cwd(), "src/styles/tailwind.css"), "utf8");

describe("mobile WeChat-style session header", () => {
  it("moves transient running state into the mobile title and restores the session title reactively", () => {
    expect(mainPane).toContain("const mobileHeaderTitle = computed");
    expect(mainPane).toContain('return "正在整理上下文…"');
    expect(mainPane).toContain("正在思考…");
    expect(mainPane).toContain('class="md:hidden"');
    expect(mainPane).toContain('class="hidden md:inline"');
    expect(mainPane).toContain("grid-cols-[2.25rem_minmax(0,1fr)_2.25rem]");
    expect(mainPane).toContain("cw-main-header-copy min-w-0 text-center md:flex-1 md:text-left");
    expect(mainPane).toContain("flex items-center justify-center gap-2 truncate text-[11px]");
    expect(mainPane).toContain("md:justify-start");
    expect(mainPane).toContain("Click to copy working directory");
    expect(mainPane).toContain("Click to copy full session id");
    expect(mainPane).toContain("cw-main-header-meta font-sans font-normal tracking-normal");
    expect(mainPane).not.toContain('class="font-mono opacity-70 shrink-0');
    expect(css).toContain(".cw-main-header-meta .cw-agent-badge-label");
    expect(mainPane).toContain("md:flex md:min-h-0 md:px-4 md:py-3");
  });

  it("uses one shared three-dot status trigger on mobile and desktop", () => {
    expect(mainPane).toContain("SessionStatusPage");
    expect(mainPane).toContain('aria-label="会话状态与操作"');
    expect(mainPane).toContain('class="hidden md:flex items-center gap-3 shrink-0"');
    expect(mainPane).toContain('class="flex h-9 w-9 shrink-0 items-center justify-center justify-self-end');
    expect(statusPage).toContain("fixed inset-0");
    expect(statusPage).toContain("md:max-w-2xl");
    expect(statusPage).toContain("md:bg-black/40");
    expect(statusPage).not.toContain('text-[var(--cw-text)] md:hidden"');
    expect(statusPage).toContain("会话信息");
    expect(statusPage).toContain('aria-label="返回会话"');
    expect(statusPage).not.toContain("与 <span");
    expect(statusPage).not.toContain("rounded-t-[22px]");
  });

  it("shares the slash-status model and exposes the process kill rather than a duplicate stop", () => {
    expect(localCommands).toContain("export async function buildSessionStatusSummary");
    expect(localCommands).toContain("const summary = await buildSessionStatusSummary(ctx)");
    expect(statusPage).toContain("buildSessionStatusSummary");
    expect(statusPage).not.toContain("stopSession");
    expect(statusPage).toContain("普通停止回复请使用输入框旁的停止键");
    expect(statusPage).toContain("killSession");
    expect(statusPage).toContain("强制终止 Codex 后台");
    expect(statusPage).toContain("终止 Claude 进程");
    expect(statusPage).toContain("再次点击确认终止");
  });

  it("keeps context and usage out of the transcript and inside the three-dot details page", () => {
    expect(assistantBlock).not.toContain("ContextFooter");
    expect(assistantBlock).not.toContain("loadCodexUsageBreakdown");
    expect(statusPage).toContain("ContextFooter");
    expect(statusPage).toContain("上下文用量");
    expect(statusPage).toContain('rows.value.filter(row => row.label !== "Context")');
    expect(statusPage).toContain("readFullCodexContextUsage");
    expect(statusPage).toContain("void loadCodexUsageBreakdown()");
    expect(statusPage).toContain("已压缩 {{ fullCompactionCount }} 次");
  });

  it("paints the native top safe area with the active panel background", () => {
    expect(css).toMatch(
      /\.cw-app-shell\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top\);[^}]*background:\s*var\(--cw-panel-bg\);/s,
    );
  });
});
