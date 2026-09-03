import { describe, expect, it } from "vitest";
import {
  searchableRecordPrefix,
  searchableRecordText,
} from "../src/services/search-text.js";

describe("visible transcript search text", () => {
  it("keeps Claude user/assistant text and rejects metadata and tool results", () => {
    expect(searchableRecordText(JSON.stringify({
      type: "assistant",
      uuid: "a1",
      cwd: "C:/英国-noise",
      message: {
        content: [
          { type: "text", text: "Visible answer" },
          { type: "tool_use", input: { query: "hidden tool text" } },
        ],
      },
    }))).toEqual({ haystack: "visible answer", uuid: "a1" });
    expect(searchableRecordText(JSON.stringify({
      type: "user",
      uuid: "tool-result",
      message: { content: [{ type: "tool_result", content: "hidden tool output" }] },
    }))).toBeNull();
    expect(searchableRecordText(JSON.stringify({
      type: "assistant",
      uuid: "sidechain",
      isSidechain: true,
      message: { content: "hidden sidechain" },
    }))).toBeNull();
  });

  it("uses only clean Codex event messages", () => {
    expect(searchableRecordText(JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", id: "u1", message: "Visible prompt" },
    }))).toEqual({ haystack: "visible prompt", uuid: "u1" });
    expect(searchableRecordText(JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "Visible answer" },
    }))).toEqual({ haystack: "visible answer", uuid: null });
    expect(searchableRecordText(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "UserMessage", id: "u2", content: [{ type: "text", text: "New visible prompt" }] },
      },
    }))).toEqual({ haystack: "new visible prompt", uuid: "u2" });
    expect(searchableRecordText(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "AgentMessage", id: "a2", content: [{ type: "Text", text: "New visible answer" }] },
      },
    }))).toEqual({ haystack: "new visible answer", uuid: "a2" });
    expect(searchableRecordText(JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: "hidden tool output",
      },
    }))).toBeNull();
    expect(searchableRecordText(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", message: "hidden completion copy" },
    }))).toBeNull();
  });

  it("classifies oversized prefixes before raw gram collection", () => {
    expect(searchableRecordPrefix(JSON.stringify({
      type: "assistant",
      uuid: "large",
      message: { content: "visible" },
    }))).toBe(true);
    expect(searchableRecordPrefix(JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", output: "hidden" },
    }))).toBe(false);
    expect(searchableRecordPrefix(JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "hidden" }] },
    }))).toBe(false);
    expect(searchableRecordPrefix(JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "visible" },
    }))).toBe(true);
    expect(searchableRecordPrefix(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "AgentMessage", content: [{ type: "Text", text: "visible" }] },
      },
    }))).toBe(true);
  });
});
