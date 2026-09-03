import { describe, expect, it } from "vitest";
import { codexRuntimeProgressEvent } from "../src/util/codex-runtime-progress.js";

const line = (type: string, payload: object) => JSON.stringify({ type, payload });

describe("codexRuntimeProgressEvent", () => {
  it("starts a fresh progress trail on a user message", () => {
    expect(codexRuntimeProgressEvent(line("event_msg", {
      type: "user_message",
      message: "publish it",
    }))).toEqual({ type: "start", preview: "publish it" });
  });

  it("returns assistant text for durable sidebar-preview reconciliation", () => {
    expect(codexRuntimeProgressEvent(line("event_msg", {
      type: "agent_message",
      message: "Checking the live stream now.",
    }))).toEqual({ type: "assistant", preview: "Checking the live stream now." });
  });

  it("surfaces newer item_completed user and assistant messages", () => {
    expect(codexRuntimeProgressEvent(line("event_msg", {
      type: "item_completed",
      item: { type: "UserMessage", content: [{ type: "text", text: "publish newer" }] },
    }))).toEqual({ type: "start", preview: "publish newer" });
    expect(codexRuntimeProgressEvent(line("event_msg", {
      type: "item_completed",
      item: { type: "AgentMessage", content: [{ type: "Text", text: "Checking newer stream." }] },
    }))).toEqual({ type: "assistant", preview: "Checking newer stream." });
  });

  it("recognizes durable terminal records even when the status push was missed", () => {
    expect(codexRuntimeProgressEvent(line("event_msg", {
      type: "task_complete",
      turn_id: "turn-1",
      last_agent_message: "The completed reply may be repeated here.",
    })))
      .toEqual({ type: "terminal" });
    expect(codexRuntimeProgressEvent(line("event_msg", { type: "turn_aborted" })))
      .toEqual({ type: "terminal" });
  });

  it("recognizes durable compaction completion without ending the turn", () => {
    expect(codexRuntimeProgressEvent(line("event_msg", {
      type: "context_compacted",
    }))).toEqual({ type: "compaction-complete" });
  });

  it("summarizes tool start and completion records", () => {
    expect(codexRuntimeProgressEvent(line("response_item", {
      type: "function_call",
      call_id: "call-1",
      name: "Bash",
      arguments: JSON.stringify({ command: "npm test" }),
    }))).toEqual({
      type: "tool-start",
      callId: "call-1",
      label: "⚙ Bash · npm test",
    });
    expect(codexRuntimeProgressEvent(line("response_item", {
      type: "function_call_output",
      call_id: "call-1",
      output: "passed",
    }))).toEqual({ type: "tool-complete", callId: "call-1" });
  });

  it("ignores reasoning and malformed records", () => {
    expect(codexRuntimeProgressEvent(line("response_item", { type: "reasoning" }))).toBeNull();
    expect(codexRuntimeProgressEvent("not-json")).toBeNull();
  });
});
