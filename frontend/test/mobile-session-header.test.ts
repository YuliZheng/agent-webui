import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mainPane = readFileSync(join(process.cwd(), "src/components/MainPane.vue"), "utf8");
const statusPage = readFileSync(join(process.cwd(), "src/components/SessionStatusPage.vue"), "utf8");
const localCommands = readFileSync(join(process.cwd(), "src/util/local-commands.ts"), "utf8");
const css = readFileSync(join(process.cwd(), "src/styles/tailwind.css"), "utf8");

describe("mobile WeChat-style session header", () => {
  it("moves transient running state into the mobile title and restores the session title reactively", () => {
    expect(mainPane).toContain("const mobileHeaderTitle = computed");
    expect(mainPane).toContain('return "正在整理上下文…"');
    expect(mainPane).toContain("正在思考…");
    expect(mainPane).toContain('class="md:hidden"');
    expect(mainPane).toContain('class="hidden md:inline"');
  });

  it("replaces mobile header pills with one three-dot full-page status trigger", () => {
    expect(mainPane).toContain("SessionStatusPage");
    expect(mainPane).toContain('aria-label="会话状态与操作"');
    expect(mainPane).toContain('class="hidden md:flex items-center gap-3 shrink-0"');
    expect(mainPane).toContain('class="md:hidden -mr-2');
    expect(statusPage).toContain("fixed inset-0");
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

  it("paints the native top safe area with the active panel background", () => {
    expect(css).toMatch(
      /\.cw-app-shell\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top\);[^}]*background:\s*var\(--cw-panel-bg\);/s,
    );
  });
});
