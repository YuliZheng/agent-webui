import { describe, expect, it } from "vitest";
import { contextUsagePercent, groupBlocks, normalizeLines, reconstructTodos } from "@/parser";
import { normalizeClaudeLine } from "@/parser/claude";
import { isCodexInjectedContext } from "@/parser/codex";
import type { NormalizedBlock } from "@/types";

const line = (index: number, value: unknown) => ({ index, raw: JSON.stringify(value) });
describe("transcript parser", () => {
  it("drops Codex-injected context and empty task notification artifacts", () => {
    expect(isCodexInjectedContext("# AGENTS.md instructions\n\n<INSTRUCTIONS>\nsecret")).toBe(true);
    const blocks = normalizeLines("codex", [
      line(1, { type: "response_item", timestamp: "2026-07-23T00:00:00Z", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nsecret" }]
      } }),
      line(2, { type: "event_msg", timestamp: "2026-07-23T00:00:01Z", payload: { type: "task_started" } }),
      line(3, { type: "event_msg", timestamp: "2026-07-23T00:00:02Z", payload: { type: "user_message", message: "real prompt" } }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "user", text: "real prompt", uuid: "line-3" });
  });

  it("normalizes queued command attachments as user prompts and drops queue bookkeeping", () => {
    expect(normalizeClaudeLine(line(4, { type: "attachment", attachment: { type: "queued_command", command: "next" } }))[0]).toMatchObject({ index: 4, kind: "user", text: "next" });
    expect(normalizeClaudeLine(line(5, { type: "queue-operation", operation: "enqueue" }))).toEqual([]);
  });
  it("dispatches and pairs Claude tool use/results without renumbering", () => {
    const blocks = normalizeLines("claude", [
      line(7, { type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file: "x" } }] } }),
      line(11, { type: "user", uuid: "u", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] } })
    ]);
    expect(blocks).toHaveLength(1); expect(blocks[0]).toMatchObject({ index: 7, kind: "tool", toolName: "Read", matched: true, sourceIndexes: [7, 11] });
  });
  it("keeps Claude image and PDF attachment metadata on the user prompt", () => {
    const blocks = normalizeClaudeLine(line(12, {
      type: "user",
      uuid: "attachments",
      message: {
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          { type: "document", filename: "notes.pdf", source: { type: "base64", media_type: "application/pdf", data: "cGRm" } },
          { type: "text", text: "Review these" }
        ]
      }
    }));
    expect(blocks).toEqual([
      expect.objectContaining({
        kind: "user",
        text: "Review these",
        images: ["data:image/png;base64,aGVsbG8="],
        meta: { pdfs: ["notes.pdf"] }
      })
    ]);
  });
  it("renders defensive Codex user/assistant events and ignores unknown records", () => {
    const blocks = normalizeLines("codex", [line(2, { type: "event_msg", timestamp: "x", payload: { type: "user_message", message: "hello" } }), line(3, { type: "future", payload: {} })]);
    expect(blocks).toEqual([expect.objectContaining({ index: 2, kind: "user", text: "hello", agent: "codex", uuid: "line-2" })]);
  });
  it("does not render Codex developer or system execution context as chat", () => {
    const blocks = normalizeLines("codex", [
      line(4, { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>internal</permissions instructions>" }] } }),
      line(5, { type: "response_item", payload: { type: "message", role: "system", content: [{ type: "input_text", text: "internal system prompt" }] } }),
      line(6, { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible answer" }] } })
    ]);
    expect(blocks).toEqual([expect.objectContaining({ index: 6, kind: "assistant", text: "visible answer" })]);
  });
  it("attaches interleaved sidechain records to their matching Task tool", () => {
    const blocks = normalizeLines("claude", [
      line(1, { type: "assistant", uuid: "parent", message: { content: [{ type: "tool_use", id: "task-1", name: "Task", input: { agentId: "agent-7" } }] } }),
      line(2, { type: "assistant", uuid: "side-a", isSidechain: true, agentId: "agent-7", message: { content: [{ type: "text", text: "subagent one" }] } }),
      line(3, { type: "assistant", uuid: "main", message: { content: [{ type: "text", text: "main timeline" }] } }),
      line(4, { type: "assistant", uuid: "side-b", isSidechain: true, agentId: "unknown", message: { content: [{ type: "text", text: "unmatched stays visible" }] } })
    ]);
    expect(blocks[0]).toMatchObject({ kind: "tool", children: [expect.objectContaining({ text: "subagent one", sidechain: true })] });
    expect(blocks.some((block) => block.text === "unmatched stays visible")).toBe(true);
  });
  it("conservatively deduplicates adjacent Codex message/event copies", () => {
    const blocks = normalizeLines("codex", [
      line(8, { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "same" }] } }),
      line(9, { type: "event_msg", payload: { type: "agent_message", message: "same" } })
    ]);
    expect(blocks).toHaveLength(1); expect(blocks[0]?.sourceIndexes).toEqual([8, 9]);
  });
  it("drops empty Codex reasoning and lets usage metadata sit between collapsible tools", () => {
    expect(normalizeLines("codex", [
      line(1, { type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "opaque" } })
    ])).toEqual([]);
    const blocks = normalizeLines("codex", [
      line(2, { type: "response_item", payload: { type: "function_call", call_id: "one", name: "Read", arguments: "{}" } }),
      line(3, { type: "response_item", payload: { type: "function_call_output", call_id: "one", output: "ok" } }),
      line(4, { type: "event_msg", payload: { type: "token_count", info: { total_tokens: 70, model_context_window: 100 } } }),
      line(5, { type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "opaque" } }),
      line(6, { type: "response_item", payload: { type: "function_call", call_id: "two", name: "Read", arguments: "{}" } }),
      line(7, { type: "response_item", payload: { type: "function_call_output", call_id: "two", output: "ok" } })
    ]);
    expect(blocks).toEqual([
      expect.objectContaining({
        kind: "tool-run",
        children: [
          expect.objectContaining({ toolUseId: "one", meta: { usage: { total_tokens: 70, model_context_window: 100 } } }),
          expect.objectContaining({ toolUseId: "two" })
        ]
      })
    ]);
    expect(contextUsagePercent(blocks)).toBe(70);
  });
  it("does not compare Codex cumulative totals with one context window", () => {
    expect(contextUsagePercent([usageBlock({
      total_token_usage: { input_tokens: 380, output_tokens: 20, total_tokens: 400 },
      model_context_window: 100
    })])).toBeNull();
  });
  it("uses Codex last-token usage instead of its cumulative total", () => {
    expect(contextUsagePercent([usageBlock({
      total_token_usage: { input_tokens: 380, output_tokens: 20, total_tokens: 400 },
      last_token_usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      model_context_window: 100
    })])).toBe(25);
  });
  it("accepts a reliable current usage snapshot and its paired context window", () => {
    expect(contextUsagePercent([usageBlock({
      current_token_usage: {
        input_tokens: 50,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 10
      },
      model_context_window: 100
    })])).toBe(80);
  });
  it("rejects malformed, conflicting, and over-limit usage instead of showing 100", () => {
    const invalid = [
      { last_token_usage: { total_tokens: "80" }, model_context_window: 100 },
      { last_token_usage: { total_tokens: 80 }, model_context_window: "100" },
      { last_token_usage: { total_tokens: 101 }, model_context_window: 100 },
      { last_token_usage: { total_tokens: 80 }, model_context_window: 100, context_window: 200 }
    ];
    for (const usage of invalid) {
      expect(contextUsagePercent([usageBlock(usage)])).toBeNull();
    }
    expect(contextUsagePercent([usageBlock({
      last_token_usage: { total_tokens: 996 },
      model_context_window: 1000
    })])).toBe(99);
    expect(contextUsagePercent([
      usageBlock({ last_token_usage: { total_tokens: 40 }, model_context_window: 100 }),
      usageBlock({ last_token_usage: { total_tokens: 101 }, model_context_window: 100 })
    ])).toBeNull();
  });
  it("collapses only settled plain tools and keeps rich, interactive and unmatched calls separate", () => {
    const tool = (key: string, overrides: Partial<NormalizedBlock> = {}): NormalizedBlock => ({ ...baseTool(key), ...overrides });
    expect(groupBlocks([tool("a"), tool("b")])).toEqual([
      expect.objectContaining({ kind: "tool-run", children: [expect.objectContaining({ key: "a" }), expect.objectContaining({ key: "b" })] })
    ]);
    const visible = groupBlocks([
      tool("unmatched", { matched: false, toolResult: undefined }),
      tool("question", { toolName: "AskUserQuestion" }),
      tool("rich", { toolResult: { previewUrl: "/preview/id/index.html" } }),
      tool("agent", { toolName: "Agent", children: [{ ...baseTool("child"), kind: "assistant", text: "working" }] })
    ]);
    expect(visible.map((block) => block.key)).toEqual(["unmatched", "question", "rich", "agent"]);
  });
  it("reconstructs TaskCreate/TaskUpdate using the created task id from the result", () => {
    const todos = reconstructTodos([
      { key: "create", index: 1, sourceIndexes: [1], kind: "tool", agent: "claude", toolUseId: "call-1", toolName: "TaskCreate", toolInput: { subject: "Run checks" }, toolResult: { taskId: "task-7" } },
      { key: "update", index: 2, sourceIndexes: [2], kind: "tool", agent: "claude", toolUseId: "call-2", toolName: "TaskUpdate", toolInput: { taskId: "task-7", status: "completed" } }
    ]);
    expect(todos).toEqual([{ id: "task-7", subject: "Run checks", status: "completed" }]);
  });
});

function baseTool(key: string): NormalizedBlock {
  return {
    key,
    index: Number(key.length),
    sourceIndexes: [Number(key.length)],
    kind: "tool" as const,
    agent: "claude" as const,
    toolUseId: `tool-${key}`,
    toolName: "Read",
    toolInput: { path: key },
    toolResult: "done",
    matched: true
  };
}

function usageBlock(usage: Record<string, unknown>): NormalizedBlock {
  return {
    key: "usage",
    index: 1,
    sourceIndexes: [1],
    kind: "assistant",
    agent: "codex",
    meta: { usage }
  };
}
