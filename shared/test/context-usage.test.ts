import { describe, expect, it } from "vitest";
import {
  CodexContextUsageAccumulator,
  summarizeCodexContextUsage,
} from "../src/codex/context-usage.js";

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type, payload });
}

function message(role: string, text: string): string {
  return line("response_item", {
    type: "message",
    role,
    content: [{ type: "input_text", text }],
  });
}

function usage(total: number, window = 258_400): string {
  return line("event_msg", {
    type: "token_count",
    info: {
      last_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total },
      model_context_window: window,
    },
  });
}

describe("Codex full context usage accumulator", () => {
  it("scans more than the old 2,000-line fallback and reconciles exactly", () => {
    const lines = [
      JSON.stringify({ type: "compacted", payload: { message: "summary" } }),
      ...Array.from({ length: 2_501 }, (_, index) => message("user", `message ${index} ${"x".repeat(40)}`)),
      usage(100_000),
    ];
    const result = summarizeCodexContextUsage(lines);

    expect(result.tokens).toBe(100_000);
    expect(result.compactionCount).toBe(1);
    expect(result.contributors?.find((item) => item.source === "user")?.tokens).toBeGreaterThan(30_000);
    expect(result.contributors?.reduce((sum, item) => sum + item.tokens, 0)).toBe(100_000);
    expect(result.contributors?.reduce((sum, item) => sum + item.percent, 0)).toBe(100);
  });

  it("forgets sources before the latest compaction", () => {
    const result = summarizeCodexContextUsage([
      message("assistant", "old answer ".repeat(500)),
      JSON.stringify({ type: "compacted", payload: { message: "summary" } }),
      message("assistant", "middle answer ".repeat(200)),
      JSON.stringify({ type: "event_msg", payload: { type: "context_compacted" } }),
      message("user", "new request"),
      usage(10_000),
    ]);
    expect(result.compactionCount).toBe(2);
    expect(result.contributors?.some((item) => item.source === "assistant")).toBe(false);
    expect(result.contributors?.some((item) => item.source === "user")).toBe(true);
  });

  it("calibrates the stable hidden Codex base separately from the changing estimate gap", () => {
    const accumulator = new CodexContextUsageAccumulator();
    accumulator.pushRawLine(message("user", "hello"));
    accumulator.pushRawLine(usage(10_000));
    const first = accumulator.result();
    const base = first.contributors?.find((item) => item.source === "base")?.tokens ?? 0;
    expect(base).toBeGreaterThan(9_000);
    expect(first.contributors?.find((item) => item.source === "other")).toBeUndefined();

    accumulator.pushRawLine(message("assistant", "reply"));
    accumulator.pushRawLine(usage(12_000));
    const grown = accumulator.result();
    expect(grown.contributors?.find((item) => item.source === "base")?.tokens).toBe(base);
    expect(grown.contributors?.find((item) => item.source === "other")?.tokens).toBeGreaterThan(1_000);

    accumulator.pushRawLine(JSON.stringify({ type: "event_msg", payload: { type: "context_compacted" } }));
    accumulator.pushRawLine(message("user", "new request"));
    accumulator.pushRawLine(usage(15_000));
    const compacted = accumulator.result();
    expect(compacted.contributors?.find((item) => item.source === "base")?.tokens).toBe(base);
    expect(compacted.contributors?.reduce((sum, item) => sum + item.tokens, 0)).toBe(15_000);
  });

  it("classifies an oversized streamed tool result from its bounded prefix", () => {
    const accumulator = new CodexContextUsageAccumulator();
    accumulator.pushRawLine(line("response_item", {
      type: "function_call",
      call_id: "call-1",
      name: "shell_command",
      arguments: "{}",
    }));
    accumulator.pushOversizedPrefix(
      '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"',
    );
    accumulator.pushRawLine(usage(8_000));

    const result = accumulator.result();
    expect(result.contributors?.find((item) => item.source === "shell")?.tokens).toBeGreaterThanOrEqual(2_000);
    expect(result.contributors?.reduce((sum, item) => sum + item.tokens, 0)).toBe(8_000);
  });
});
