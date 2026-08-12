import { describe, expect, it } from "vitest";
import type { TimelineNode } from "../src/parser/group.js";
import { currentTurnProgress } from "../src/util/turn-progress.js";

function event(block: TimelineNode["block"], content: unknown): TimelineNode {
  return { kind: "event", block, record: { message: { content } } };
}

describe("currentTurnProgress", () => {
  it("uses the latest assistant progress message from the current turn", () => {
    const timeline: TimelineNode[] = [
      event("UserPromptBlock", "old prompt"),
      event("AssistantBlock", [{ type: "text", text: "Old update" }]),
      event("UserPromptBlock", "new prompt"),
      event("AssistantBlock", [{ type: "text", text: "Checking the message stream now." }]),
    ];

    expect(currentTurnProgress(timeline)).toEqual({
      label: "Latest update · Checking the message stream now.",
      completedActions: 0,
      updates: 1,
    });
  });

  it("reports the latest completed action when there is no newer update", () => {
    const node = event("AssistantBlock", []);
    node.toolPairs = [{
      use: { id: "call-1", name: "Bash", input: { command: "npm test" } },
      result: "passed",
    }];

    expect(currentTurnProgress([event("UserPromptBlock", "test it"), node])).toEqual({
      label: "✓ Completed · Bash · npm test",
      completedActions: 1,
      updates: 0,
    });
  });

  it("prefers a progress message written after a completed action", () => {
    const tool = event("AssistantBlock", []);
    tool.toolPairs = [{
      use: { id: "call-1", name: "Bash", input: { command: "npm test" } },
      result: "passed",
    }];

    const progress = currentTurnProgress([
      event("UserPromptBlock", "test it"),
      tool,
      event("AssistantBlock", [{ type: "text", text: "Tests passed; checking types next." }]),
    ]);
    expect(progress.label).toBe("Latest update · Tests passed; checking types next.");
    expect(progress.completedActions).toBe(1);
    expect(progress.updates).toBe(1);
  });

  it("does not count an in-flight tool as completed", () => {
    const node = event("AssistantBlock", []);
    node.toolPairs = [{
      use: { id: "call-1", name: "Bash", input: { command: "npm test" } },
      result: undefined,
    }];

    expect(currentTurnProgress([event("UserPromptBlock", "test it"), node])).toEqual({
      label: "",
      completedActions: 0,
      updates: 0,
    });
  });
});
