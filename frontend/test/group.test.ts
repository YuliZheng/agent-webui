import { describe, it, expect } from "vitest";
import { groupTimeline, type TimelineNode } from "../src/parser/group.js";

function rec(o: object) { return JSON.stringify(o); }

describe("groupTimeline", () => {
  it("returns one event per renderable line in order", () => {
    const lines = [
      rec({ type: "user", message: { content: "hi" }, uuid: "u1" }),
      rec({ type: "assistant", message: { content: [{ type: "text", text: "yo" }] }, uuid: "a1" }),
    ];
    const t = groupTimeline(lines);
    expect(t.length).toBe(2);
    expect(t[0]!.kind).toBe("event");
    expect(t[1]!.kind).toBe("event");
  });

  it("pairs tool_use with matching tool_result", () => {
    const lines = [
      rec({
        type: "assistant", uuid: "a1",
        message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] },
      }),
      rec({
        type: "user", uuid: "u1",
        message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
      }),
    ];
    const t = groupTimeline(lines);
    expect(t.length).toBe(1);
    const node = t[0]! as Extract<TimelineNode, { kind: "event" }>;
    expect(node.toolPairs?.length).toBe(1);
    expect(node.toolPairs?.[0]?.use.id).toBe("tu1");
    expect(node.toolPairs?.[0]?.result).toBeDefined();
  });

  it("attachment(queued_command) is synthesized into a UserPromptBlock", () => {
    const lines = [
      rec({
        type: "attachment",
        uuid: "att1",
        timestamp: "2026-05-17T14:11:45.014Z",
        attachment: { type: "queued_command", prompt: "what is 2+2?", commandMode: "prompt" },
      }),
    ];
    const t = groupTimeline(lines);
    expect(t.length).toBe(1);
    const node = t[0]! as Extract<TimelineNode, { kind: "event" }>;
    expect(node.block).toBe("UserPromptBlock");
    expect((node.record.message as { content?: unknown })?.content).toBe("what is 2+2?");
    expect(node.record.uuid).toBe("att1");
  });

  it("queue-operation records are excluded from the timeline", () => {
    const lines = [
      rec({ type: "queue-operation", operation: "enqueue", content: "ignored", timestamp: "" }),
      rec({ type: "queue-operation", operation: "remove", timestamp: "" }),
      rec({ type: "queue-operation", operation: "dequeue", timestamp: "" }),
      rec({ type: "user", message: { content: "real" }, uuid: "u1" }),
    ];
    const t = groupTimeline(lines);
    expect(t.length).toBe(1);
    expect(t[0]!.kind).toBe("event");
    const node = t[0]! as Extract<TimelineNode, { kind: "event" }>;
    expect(node.record.uuid).toBe("u1");
  });

  it("attachment(non-queued-command) is dropped from the timeline", () => {
    const lines = [
      rec({ type: "attachment", attachment: { type: "hook_success", content: "" } }),
      rec({ type: "user", message: { content: "real" }, uuid: "u1" }),
    ];
    const t = groupTimeline(lines);
    expect(t.length).toBe(1);
    expect((t[0]! as Extract<TimelineNode, { kind: "event" }>).record.uuid).toBe("u1");
  });

  it("preserves the physical source line for structured Claude images", () => {
    const lines = [
      "",
      rec({
        type: "user",
        uuid: "image-user",
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
            { type: "text", text: "caption" },
          ],
        },
      }),
    ];
    const t = groupTimeline(lines);
    expect(t).toHaveLength(1);
    expect((t[0]! as Extract<TimelineNode, { kind: "event" }>).record.__agentWebuiSourceIndex).toBe(1);
  });

  it("nests sidechain events under parent Agent tool_use", () => {
    const lines = [
      rec({
        type: "assistant", uuid: "a1",
        message: { content: [{ type: "tool_use", id: "ag1", name: "Agent", input: { subagent_type: "explore", description: "x" } }] },
      }),
      rec({
        type: "assistant", uuid: "a2", isSidechain: true, parentUuid: "a1",
        message: { content: [{ type: "text", text: "in subagent" }] },
      }),
      rec({
        type: "user", uuid: "u1",
        message: { content: [{ type: "tool_result", tool_use_id: "ag1", content: "done" }] },
      }),
    ];
    const t = groupTimeline(lines);
    expect(t.length).toBe(1);
    const node = t[0]! as Extract<TimelineNode, { kind: "event" }>;
    expect(node.toolPairs?.[0]?.subagentTimeline?.length).toBe(1);
  });
});
