import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const status = readFileSync(join(process.cwd(), "src/components/HomeConnectionStatus.vue"), "utf8");
const sidebar = readFileSync(join(process.cwd(), "src/components/Sidebar.vue"), "utf8");
const app = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");

describe("mobile home connection diagnostics", () => {
  it("distinguishes the local relay from an unavailable upstream computer", () => {
    expect(status).toContain('fetch("/health"');
    expect(status).toContain('body.status === "running"');
    expect(status).toContain('"relay-missing"');
    expect(status).toContain('"upstream-missing"');
    expect(status).toContain("工作资料中带公文包标记的 Tailnet Relay");
    expect(status).toContain("工作资料里的 Tailscale");
  });

  it("keeps cached chats visible and offers a bounded manual retry", () => {
    expect(status).toContain("下方显示的是上次保存的会话");
    expect(status).toContain("wsWake({ forceReconnect: true })");
    expect(status).toContain("await sessions.fetchAll()");
    expect(status).toContain("重新连接");
    expect(sidebar).toContain('<HomeConnectionStatus v-if="!searchOpen" class="md:hidden" />');
  });

  it("turns a completed sync failure into a retryable state", () => {
    expect(status).toContain("const syncFailed = computed");
    expect(status).toContain("sessions.syncInFlight === 0");
    expect(status).toContain("!!sessions.lastError");
    expect(status).toContain("会话同步失败");
    expect(status).toContain("sessions.lastError");
  });

  it("replaces the developer-only fatal message with a recoverable Chinese screen", () => {
    expect(app).toContain("暂时无法打开 Agent WebUI");
    expect(app).toContain("重新加载");
    expect(app).toContain("查看错误详情");
    expect(app).not.toContain("?token=&lt;your-token&gt;");
  });
});
