import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contextPressureState } from "../src/util/context-pressure.js";

const noticeVue = readFileSync(join(process.cwd(), "src/components/ContextPressureNotice.vue"), "utf8");
const mainPaneVue = readFileSync(join(process.cwd(), "src/components/MainPane.vue"), "utf8");

describe("context pressure notice", () => {
  it("stays quiet above 20% remaining and appears at the 20% boundary", () => {
    expect(contextPressureState(79_999, 100_000, false).visible).toBe(false);
    expect(contextPressureState(80_000, 100_000, false)).toMatchObject({
      visible: true,
      tone: "notice",
      remainingPercent: 20,
      title: "上下文剩余 20%",
    });
  });

  it("becomes urgent at 10% and always describes active compaction", () => {
    expect(contextPressureState(90_000, 100_000, false)).toMatchObject({
      visible: true,
      tone: "urgent",
      remainingPercent: 10,
    });
    expect(contextPressureState(0, null, true)).toMatchObject({
      visible: true,
      tone: "compacting",
      title: "正在整理上下文…",
    });
  });

  it("lets a user dismiss the warning without hiding real compaction", () => {
    expect(noticeVue).toContain('aria-label="关闭本次上下文提醒"');
    expect(noticeVue).toContain("sessionStorage.setItem");
    expect(noticeVue).toContain('state.value.tone === "compacting" || !dismissed.value');
  });

  it("offers immediate compaction and exposes its pending state", () => {
    expect(noticeVue).toContain('compactNow: []');
    expect(noticeVue).toContain("立即整理");
    expect(noticeVue).toContain("正在启动…");
    expect(noticeVue).toContain(':disabled="compactRequesting"');
    expect(noticeVue).toContain("emit('compactNow')");
  });

  it("does not offer immediate compaction while a reply is running", () => {
    expect(noticeVue).toContain("working: boolean");
    expect(noticeVue).toContain("state.tone !== 'compacting' && !working");
    expect(mainPaneVue).toContain(':working="showsWorkingState"');
    expect(mainPaneVue).toContain("!id || showsWorkingState.value || compactRequesting.value");
  });

  it("starts compaction from the main pane and recovers if no state event arrives", () => {
    expect(mainPaneVue).toContain("await compactSession(id)");
    expect(mainPaneVue).toContain("COMPACT_REQUEST_FALLBACK_MS = 20_000");
    expect(mainPaneVue).toContain('@compact-now="compactContextNow"');
    expect(mainPaneVue).toContain('title: "整理失败"');
  });

  it("keeps the mobile action row inside the notice width", () => {
    expect(noticeVue).toContain("flex-basis: calc(100% - 2.375rem)");
    expect(noticeVue).toContain("min-width: 0");
    expect(noticeVue).not.toContain("flex-basis: 100%");
  });
});
