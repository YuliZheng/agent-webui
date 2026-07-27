import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fullCodexContextUsage } from "../src/services/codex-context-usage.js";
import { MAX_JSONL_RECORD_BYTES } from "../src/services/jsonl.js";

const tempDirectories: string[] = [];

async function rollout(lines: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-webui-usage-"));
  tempDirectories.push(directory);
  const path = join(directory, "rollout.jsonl");
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

function response(payload: Record<string, unknown>): string {
  return JSON.stringify({ type: "response_item", payload });
}

function usage(total: number): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total },
        model_context_window: 258_400,
      },
    },
  });
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("full Codex context usage scan", () => {
  it("streams every physical record and keeps only the latest compact segment", async () => {
    const lines = [
      response({ type: "message", role: "assistant", content: [{ type: "output_text", text: "old" }] }),
      JSON.stringify({ type: "compacted", payload: { message: "summary" } }),
      ...Array.from({ length: 2_101 }, (_, index) => response({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `request ${index} ${"x".repeat(40)}` }],
      })),
      usage(100_000),
    ];
    const result = await fullCodexContextUsage(await rollout(lines));

    expect(result.completeHistoryScan).toBe(true);
    expect(result.recordsScanned).toBe(lines.length);
    expect(result.tokens).toBe(100_000);
    expect(result.contributors?.some((item) => item.source === "assistant")).toBe(false);
    expect(result.contributors?.find((item) => item.source === "user")?.tokens).toBeGreaterThan(25_000);
    expect(result.contributors?.reduce((sum, item) => sum + item.tokens, 0)).toBe(100_000);
    expect(result.contributors?.reduce((sum, item) => sum + item.percent, 0)).toBe(100);
    expect(result).not.toHaveProperty("lines");
  });

  it("bounds an oversized tool result while preserving its source", async () => {
    const lines = [
      response({
        type: "function_call",
        call_id: "shell-1",
        name: "shell_command",
        arguments: "{}",
      }),
      response({
        type: "function_call_output",
        call_id: "shell-1",
        output: "x".repeat(MAX_JSONL_RECORD_BYTES + 1_024),
      }),
      usage(8_000),
    ];
    const result = await fullCodexContextUsage(await rollout(lines));

    expect(result.recordsScanned).toBe(3);
    expect(result.oversizedRecords).toBe(1);
    expect(result.contributors?.find((item) => item.source === "shell")?.tokens).toBeGreaterThanOrEqual(2_000);
    expect(result.contributors?.reduce((sum, item) => sum + item.tokens, 0)).toBe(8_000);
  });
});
