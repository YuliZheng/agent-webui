import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendIncrementalTitleRequests,
  formatIncrementalTitleContext,
  formatTitleRequestContext,
  isContextDependentTitleRequest,
  recentSessionTitleContext,
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
  });

  it("puts the current request first and only expands short contextual follow-ups", () => {
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
    expect(contextual.startsWith("CURRENT REQUEST (highest priority):\n继续")).toBe(true);
    expect(contextual.indexOf("Context 1: make Claude")).toBeGreaterThan(0);
    expect(contextual.indexOf("Context 5: old topic one")).toBeGreaterThan(0);

    const changedTopic = [...requests.slice(0, -1), "Implement OAuth token rotation for the API"];
    expect(selectTitleRequests(changedTopic)).toEqual(changedTopic.slice(-4));
    expect(formatTitleRequestContext(changedTopic)).not.toContain("old topic one");
  });

  it("backfills Claude context after restart with a bounded tail read", async () => {
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
    expect(context.startsWith("CURRENT REQUEST (highest priority):\n继续")).toBe(true);
    expect(context).toContain("Context 1: 最近的对话优先");
    expect(context).toContain("Context 5: 分析旧的自动命名流程");
  });

  it("deduplicates Codex transport copies and ignores injected context", async () => {
    const records: unknown[] = [
      {
        type: "event_msg",
        payload: { type: "user_message", message: "<permissions instructions>internal</permissions instructions>" },
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
    expect(context.startsWith(
      "CURRENT REQUEST (highest priority):\nPrioritize recent requests",
    )).toBe(true);
    expect(context).toContain("Context 1: Fix the title context");
    expect(context).not.toContain("permissions instructions");
    expect(context.match(/Fix the title context/g)).toHaveLength(1);
  });
});
