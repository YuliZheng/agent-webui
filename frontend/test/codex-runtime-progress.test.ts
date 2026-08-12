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

  it("surfaces an assistant commentary update", () => {
    expect(codexRuntimeProgressEvent(line("event_msg", {
      type: "agent_message",
      message: "Checking the live stream now.",
    }))).toEqual({
      type: "update",
      label: "Latest update · Checking the live stream now.",
      preview: "Checking the live stream now.",
    });
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
