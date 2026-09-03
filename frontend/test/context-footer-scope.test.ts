import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it } from "vitest";
import ContextFooter from "../src/components/blocks/ContextFooter.vue";
import { useSessionsStore } from "../src/stores/sessions.js";

const mounted: Array<ReturnType<typeof createApp>> = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("context footer usage scope", () => {
  it("defaults to all-time usage and switches to the active context", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const sessionId = "01a04941-94fd-7860-8734-4986052cad04";
    useSessionsStore().byId[sessionId] = {
      id: sessionId,
      cwd: "C:\\work",
      mtime: "",
      size: 0,
      title: null,
      parentSessionId: null,
      agent: "codex",
    };

    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(ContextFooter, {
      sessionId,
      ctxTokens: 180_000,
      ctxLimit: 244_800,
      cumulativeTokens: 127_161_239,
      ctxCumulativeContributors: [
        { source: "user", label: "your messages", tokens: 40_000_000, percent: 31 },
        { source: "reasoning", label: "reasoning", tokens: 35_000_000, percent: 28 },
        { source: "shell", label: "shell", tokens: 20_000_000, percent: 16 },
        { source: "browser", label: "browser", tokens: 12_000_000, percent: 9 },
        { source: "assistant", label: "assistant replies", tokens: 10_000_000, percent: 8 },
        { source: "other", label: "unattributed context", tokens: 10_161_239, percent: 8 },
      ],
      weeklyUsagePercent: 12.5,
      weeklyUsageWindow: {
        usedPercent: 12.5,
        windowDurationMins: 7 * 24 * 60,
        resetsAt: Date.UTC(2026, 7, 29) / 1_000,
      },
      dailyUsageBuckets: Array.from({ length: 7 }, (_, index) => ({
        startDate: `2026-08-${String(22 + index).padStart(2, "0")}`,
        tokens: 10_000_000,
      })),
      planType: "pro",
      threadUsage: {
        threadId: sessionId,
        estimatedUsageCreditsMicros: 12_500_000,
        estimatedUsageUsdMicros: null,
        groups: [
          {
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
            speed: "standard",
            inputTokens: 90_000_000,
            cachedInputTokens: 70_000_000,
            netNewInputTokens: 20_000_000,
            outputTokens: 5_000_000,
            totalTokens: 95_000_000,
            estimatedUsageCreditsMicros: 10_000_000,
          },
          {
            model: "gpt-5.6-terra",
            reasoningEffort: "medium",
            speed: "priority",
            inputTokens: 30_000_000,
            cachedInputTokens: 20_000_000,
            netNewInputTokens: 10_000_000,
            outputTokens: 2_161_239,
            totalTokens: 32_161_239,
            estimatedUsageCreditsMicros: 2_500_000,
          },
        ],
      },
      ctxContributors: [
        { source: "user", label: "User messages", tokens: 60_000, percent: 33.3 },
        { source: "reasoning", label: "Reasoning", tokens: 120_000, percent: 66.7 },
      ],
    });
    app.use(pinia);
    mounted.push(app);
    app.mount(host);

    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>(".cw-context-scope-switch button"));
    expect(buttons.map(button => [button.textContent?.trim(), button.getAttribute("aria-pressed")])).toEqual([
      ["全部", "true"],
      ["当前", "false"],
    ]);
    const summary = host.querySelector(".cw-context-scope-summary")?.textContent ?? "";
    expect(summary).toContain("127.2M");
    expect(summary).toContain("≈ 22.7% 一周额度");
    expect(host.querySelector(".cw-context-usage-chart-center")?.textContent).toContain("127.2M");
    expect(host.textContent).toContain("全部历史用量");
    expect(host.textContent).toContain("用户消息");
    expect(host.textContent).toContain("Shell");
    expect(host.textContent).not.toContain("gpt-5.6-sol");
    expect(host.textContent).toContain("Pro 20x（用户确认）");
    expect(host.textContent).toContain("12.5% 已用");
    expect(host.textContent).toContain("≈ 22.7% 一周额度");

    buttons[1]?.click();
    await nextTick();

    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".cw-context-usage-chart-center")?.textContent).toContain("74%");
    expect(host.textContent).toContain("Current context sources");
  });
});
