import { describe, expect, it } from "vitest";
import {
  codexVisibleMessage,
  isCodexInjectedContextText,
  sameCodexVisibleMessage,
} from "../src/codex/messages.js";

describe("Codex visible message normalization", () => {
  it("normalizes response, legacy event, and item_completed messages", () => {
    expect(codexVisibleMessage({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    })).toEqual({ role: "assistant", text: "done", transport: "response" });
    expect(codexVisibleMessage({
      type: "event_msg",
      payload: { type: "user_message", id: "u1", client_id: "client-1", message: "go" },
    })).toEqual({
      role: "user",
      text: "go",
      transport: "legacy-event",
      id: "u1",
      clientId: "client-1",
    });
    expect(codexVisibleMessage({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "finished" }] },
      },
    })).toEqual({ role: "assistant", text: "finished", transport: "item-completed", id: "a1" });
  });

  it("rejects developer messages and recognizes injected context", () => {
    expect(codexVisibleMessage({
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "hidden" }] },
    })).toBeNull();
    expect(isCodexInjectedContextText("<permissions instructions>hidden</permissions instructions>"))
      .toBe(true);
    expect(isCodexInjectedContextText(
      "# AGENTS.md instructions for C:\\workspace\n\n<INSTRUCTIONS>hidden</INSTRUCTIONS>",
    )).toBe(true);
  });

  it("matches clean user events with response image envelopes", () => {
    const response = codexVisibleMessage({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: '<image path="C:/shot.png"></image>\n[Image #1]inspect' }],
      },
    })!;
    const event = codexVisibleMessage({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "UserMessage", content: [{ type: "text", text: "[Image #1]inspect" }] },
      },
    })!;
    expect(sameCodexVisibleMessage(response, event)).toBe(true);
  });

  it("keeps image-only item_completed user messages visible", () => {
    expect(codexVisibleMessage({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "UserMessage",
          id: "image-only-user",
          content: [
            { type: "local_image", path: "C:\\tmp\\first.png" },
            { type: "local_image", path: "C:\\tmp\\second.png" },
          ],
        },
      },
    })).toEqual({
      role: "user",
      text: "[Image #1]\n[Image #2]",
      transport: "item-completed",
      id: "image-only-user",
    });
  });
});
