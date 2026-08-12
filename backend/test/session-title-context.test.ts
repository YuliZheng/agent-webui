import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendConversationTitleRequests,
  appendIncrementalTitleRequests,
  formatIncrementalTitleContext,
  formatTitleRequestContext,
  isContextDependentTitleRequest,
  recentSessionTitleContext,
  sessionTitleRequests,
  selectTitleRequests,
} from "../src/services/session-title-context.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true }),
  ));
});

async function transcript(lines: unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-webui-title-context-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "session.jsonl");
  await writeFile(path, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

describe("session title request context", () => {
  it("keeps a complete default refresh cycle and bounds unusually long intervals", () => {
    const defaultCycle = [
      "建立自动标题",
      "增加 emoji",
      "统一 Claude 和 Codex",
      "按设置频率更新",
      "递增保存主题摘要",
    ];
    expect(appendIncrementalTitleRequests([], defaultCycle)).toEqual(defaultCycle);
    expect(formatIncrementalTitleContext(defaultCycle)).toContain(
      "1. 建立自动标题",
    );
    expect(formatIncrementalTitleContext(defaultCycle)).toContain(
      "5. 递增保存主题摘要",
    );

    const longCycle = appendIncrementalTitleRequests(
      defaultCycle,
      Array.from({ length: 10 }, (_, index) => `后续请求 ${index + 1}`),
    );
    expect(longCycle).toHaveLength(12);
    expect(longCycle[0]).toBe("建立自动标题");
    expect(longCycle.at(-1)).toBe("后续请求 10");
    const boundedCycle = formatIncrementalTitleContext(longCycle, 1_500);
    expect(boundedCycle).toContain("1. 建立自动标题");
    expect(boundedCycle).toContain("12. 后续请求 10");
    expect(boundedCycle.length).toBeLessThanOrEqual(1_500);
  });

  it("keeps a bounded conversation cache that absorbs later topic phases", () => {
    const initial = Array.from({ length: 80 }, (_, index) => `早期阶段 ${index + 1}`);
    const updated = appendConversationTitleRequests(initial, [
      "明确结束早期任务",
      "开始完全不同的新生儿房间规划",
      "整理婴儿用品清单",
    ]);
    expect(updated).toHaveLength(64);
    expect(updated[0]).toBe("早期阶段 1");
    expect(updated).toContain("开始完全不同的新生儿房间规划");
    expect(updated.at(-1)).toBe("整理婴儿用品清单");
  });

  it("samples the whole timeline instead of collapsing to the latest requests", () => {
    const requests = [
      "old topic one",
      "old topic two",
      "set up the automatic title generator",
      "add an emoji avatar",
      "make Claude and Codex share the same path",
      "继续",
    ];
    expect(isContextDependentTitleRequest("继续")).toBe(true);
    expect(isContextDependentTitleRequest("Fix login bug")).toBe(false);
    expect(selectTitleRequests(requests)).toEqual(requests);
    const contextual = formatTitleRequestContext(requests);
    expect(contextual.startsWith("CONVERSATION-WIDE USER REQUEST SAMPLE")).toBe(true);
    expect(contextual.indexOf("1. old topic one")).toBeGreaterThan(0);
    expect(contextual.indexOf("6. 继续")).toBeGreaterThan(contextual.indexOf("1. old topic one"));

    const longConversation = Array.from(
      { length: 40 },
      (_, index) => `conversation phase ${index + 1}`,
    );
    const selected = selectTitleRequests(longConversation);
    expect(selected).toHaveLength(16);
    expect(selected[0]).toBe("conversation phase 1");
    expect(selected.at(-1)).toBe("conversation phase 40");
    expect(selected.some(text => {
      const phase = Number(text.match(/\d+$/)?.[0]);
      return phase >= 15 && phase <= 25;
    })).toBe(true);
    const bounded = formatTitleRequestContext(longConversation, 3_800);
    expect(bounded).toContain("1. conversation phase 1");
    expect(bounded).toContain("16. conversation phase 40");
    expect(bounded.length).toBeLessThanOrEqual(3_800);
  });

  it("backfills Claude context after restart from the full conversation", async () => {
    const path = await transcript([
      { type: "user", uuid: "u1", message: { content: "分析旧的自动命名流程" } },
      { type: "assistant", uuid: "a1", message: { content: "done" } },
      { type: "user", uuid: "u2", message: { content: "改成 Codex 5.3" } },
      { type: "assistant", uuid: "a2", message: { content: "done" } },
      { type: "user", uuid: "u3", message: { content: "让标题带相关 emoji" } },
      { type: "assistant", uuid: "a3", message: { content: "done" } },
      { type: "user", uuid: "u4", message: { content: "侧边栏把 emoji 放进头像" } },
      { type: "assistant", uuid: "a4", message: { content: "done" } },
      { type: "user", uuid: "u5", message: { content: "最近的对话优先" } },
      { type: "user", uuid: "u6", message: { content: "继续" } },
      { type: "assistant", uuid: "a6", message: { stop_reason: "end_turn", content: "done" } },
    ]);
    const context = await recentSessionTitleContext(path, "claude", ["继续"]);
    expect(context.startsWith("CONVERSATION-WIDE USER REQUEST SAMPLE")).toBe(true);
    expect(context).toContain("1. 分析旧的自动命名流程");
    expect(context).toContain("最近的对话优先");
    expect(context).toContain("继续");
  });

  it("deduplicates Codex transport copies and ignores injected context", async () => {
    const records: unknown[] = [
      {
        type: "event_msg",
        payload: { type: "user_message", message: "<permissions instructions>internal</permissions instructions>" },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "<recommended_plugins>internal</recommended_plugins>" },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "Fix the title context" },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the title context" }] },
      },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "Prioritize recent requests" },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Prioritize recent requests" }] },
      },
    ];
    const path = await transcript(records);
    const context = await recentSessionTitleContext(path, "codex");
    expect(context.startsWith("CONVERSATION-WIDE USER REQUEST SAMPLE")).toBe(true);
    expect(context).toContain("Fix the title context");
    expect(context).toContain("Prioritize recent requests");
    expect(context).not.toContain("permissions instructions");
    expect(context).not.toContain("recommended_plugins");
    expect(context.match(/Fix the title context/g)).toHaveLength(1);
  });

  it("keeps an early core goal even when more than the old 4 MiB tail follows", async () => {
    const path = await transcript([
      { type: "user", uuid: "u1", message: { content: "重构 Agent WebUI 的自动标题系统" } },
      {
        type: "assistant",
        uuid: "a1",
        message: { content: [{ type: "text", text: "x".repeat(4 * 1024 * 1024 + 256) }] },
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        type: "user",
        uuid: `u${index + 2}`,
        message: { content: `实现阶段 ${index + 1}` },
      })),
    ]);
    const context = await recentSessionTitleContext(path, "claude");
    expect(context).toContain("重构 Agent WebUI 的自动标题系统");
    expect(context).toMatch(/实现阶段 (10|11)/);
    expect(context).toContain("实现阶段 20");
    expect(context.length).toBeLessThanOrEqual(5_400);
  });

  it("retains bounded head and tail context from a large user request record", async () => {
    const path = await transcript([
      {
        type: "user",
        uuid: "u1",
        message: {
          content: `核心目标：审计长请求标题。${"细节".repeat(160_000)}最终约束：保留全局主题。`,
        },
      },
    ]);
    const requests = await sessionTitleRequests(path, "claude");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("核心目标：审计长请求标题");
    expect(requests[0]).toContain("最终约束：保留全局主题");
    expect(requests[0]!.length).toBeLessThanOrEqual(2_003);
  });

  it("keeps uniform request landmarks after streaming compaction", async () => {
    const path = await transcript(Array.from({ length: 5_000 }, (_, index) => ({
      type: "user",
      uuid: `u${index + 1}`,
      message: { content: `阶段请求 ${index + 1}` },
    })));
    const requests = await sessionTitleRequests(path, "claude");
    expect(requests).toHaveLength(64);
    expect(requests[0]).toBe("阶段请求 1");
    expect(requests.at(-1)).toBe("阶段请求 5000");
    expect(requests.some(text => {
      const ordinal = Number(text.match(/\d+$/)?.[0]);
      return ordinal >= 2_300 && ordinal <= 2_700;
    })).toBe(true);
  });
});
