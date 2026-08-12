import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import MobileGoalPopover from "../src/components/MobileGoalPopover.vue";

const mounted: Array<ReturnType<typeof createApp>> = [];

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("mobile goal popover", () => {
  it("reveals the full goal and closes on an outside click", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(MobileGoalPopover, {
      sessionId: "019fc399-cf1d-71d1-b4c8-6468fe509918",
      goal: {
        objective: "检索并总结用户最近的所有 Codex 对话",
        status: "complete",
        tokensUsed: 40_609,
      },
    });
    mounted.push(app);
    app.mount(host);

    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="查看 Goal"]');
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    trigger?.click();
    await nextTick();

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(dialog?.textContent).toContain("检索并总结用户最近的所有 Codex 对话");
    expect(dialog?.textContent).toContain("40,609 tokens used");

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes with Escape", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(MobileGoalPopover, {
      sessionId: "session-1",
      goal: { objective: "Ship mobile goal UI", status: "active" },
    });
    mounted.push(app);
    app.mount(host);

    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="查看 Goal"]');
    trigger?.click();
    await nextTick();
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
  });
});
