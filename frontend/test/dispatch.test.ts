import { describe, it, expect } from "vitest";
import { pickBlock } from "../src/parser/dispatch.js";

describe("pickBlock", () => {
  it("user prompt string -> UserPromptBlock", () => {
    expect(pickBlock({ type: "user", message: { content: "hi" } })).toBe("UserPromptBlock");
  });
  it("user text-array -> UserPromptBlock", () => {
    expect(pickBlock({ type: "user", message: { content: [{ type: "text", text: "x" }] } })).toBe("UserPromptBlock");
  });
  it("user tool_result -> UserToolResultBlock", () => {
    expect(pickBlock({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "x", content: "" }] },
    })).toBe("UserToolResultBlock");
  });
  it("user isMeta -> hidden (harness-injected context, not shown in CLI)", () => {
    expect(pickBlock({ type: "user", isMeta: true, message: { content: "x" } })).toBe(null);
  });
  it("user isCompactSummary -> UserCompactSummaryBlock", () => {
    expect(pickBlock({ type: "user", isCompactSummary: true, message: { content: "x" } })).toBe("UserCompactSummaryBlock");
  });
  it("assistant -> AssistantBlock", () => {
    expect(pickBlock({ type: "assistant", message: { content: [] } })).toBe("AssistantBlock");
  });
  it("assistant isApiErrorMessage -> AssistantApiErrorBlock", () => {
    expect(pickBlock({ type: "assistant", isApiErrorMessage: true, message: { content: [] } })).toBe("AssistantApiErrorBlock");
  });
  it("assistant isApiErrorMessage with synthetic model still renders (not a resume artifact)", () => {
    expect(pickBlock({
      type: "assistant",
      isApiErrorMessage: true,
      message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: socket closed" }] },
    })).toBe("AssistantApiErrorBlock");
  });
  it("assistant synthetic resume ack -> null", () => {
    expect(pickBlock({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
    })).toBe(null);
  });
  it("system subtype dispatches to specific block", () => {
    expect(pickBlock({ type: "system", subtype: "turn_duration" })).toBe("TurnDurationBlock");
    expect(pickBlock({ type: "system", subtype: "stop_hook_summary" })).toBe(null);
    expect(pickBlock({ type: "system", subtype: "away_summary" })).toBe("AwaySummaryBlock");
    expect(pickBlock({ type: "system", subtype: "local_command" })).toBe("LocalCommandBlock");
    expect(pickBlock({ type: "system", subtype: "api_error" })).toBe("ApiErrorBlock");
    expect(pickBlock({ type: "system", subtype: "compact_boundary" })).toBe("CompactBoundaryBlock");
  });
  it("unknown -> null", () => {
    expect(pickBlock({ type: "permission-mode" })).toBe(null);
    expect(pickBlock(null)).toBe(null);
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

describe("pickBlock against fixture corpus", () => {
  const root = join(process.cwd(), "..", "examples", "jsonl");
  const files: string[] = [];
  function walk(dir: string) {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (e.endsWith(".jsonl")) files.push(p);
    }
  }
  try { walk(root); } catch {}

  it.skipIf(files.length === 0)("never throws on any record", () => {
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
      for (const l of lines) {
        let r: unknown;
        try { r = JSON.parse(l); } catch { continue; }
        expect(() => pickBlock(r)).not.toThrow();
      }
    }
  });
});
