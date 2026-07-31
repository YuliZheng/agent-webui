import { describe, it, expect } from "vitest";
import { codexRolloutToClaudeLines, codexToClaudeLines } from "../src/parser/codex-adapt.js";
import { groupTimeline } from "../src/parser/group.js";

// Rollout records (what the codex tail forwards): { type, payload }.
function ev(type: string, payload: object) { return JSON.stringify({ type, payload }); }
const userMsg = (text: string) => ev("event_msg", { type: "user_message", message: text });
const agentMsg = (text: string) => ev("event_msg", { type: "agent_message", message: text });
const fnCall = (callId: string, cmd: string) =>
  ev("response_item", { type: "function_call", name: "exec_command", call_id: callId, arguments: JSON.stringify({ cmd }) });
const fnOut = (callId: string, output: unknown) =>
  ev("response_item", { type: "function_call_output", call_id: callId, output });

function render(lines: string[]) {
  return groupTimeline(codexRolloutToClaudeLines(lines));
}

describe("codexToClaudeLines (rollout shape) + groupTimeline", () => {
  it("drops noise records", () => {
    expect(codexToClaudeLines(ev("session_meta", { id: "x", cwd: "/y" }))).toEqual([]);
    expect(codexToClaudeLines(ev("turn_context", { model: "gpt-5.5" }))).toEqual([]);
    expect(codexToClaudeLines(ev("event_msg", { type: "task_started", turn_id: "t" }))).toEqual([]);
    expect(codexToClaudeLines(ev("event_msg", { type: "token_count", info: {} }))).toEqual([]);
    expect(codexToClaudeLines(ev("response_item", { type: "message", role: "developer", content: [] }))).toEqual([]);
    expect(codexToClaudeLines(ev("response_item", { type: "reasoning", encrypted_content: "..." }))).toEqual([]);
    expect(codexToClaudeLines("not json")).toEqual([]);
  });

  it("renders user_message + agent_message as bubbles", () => {
    const t = render([userMsg("hello")]);
    expect(t[0]!.block).toBe("UserPromptBlock");
    expect(t[0]!.record.uuid).toBe("codex-line-0");
    expect(render([agentMsg("done")])[0]!.block).toBe("AssistantBlock");
  });

  it("pairs a structured input_image with the clean user event without duplicating the prompt", () => {
    const imageLine = ev("response_item", {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: '<image path="C:\\tmp\\shot.png"></image>' },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        { type: "input_text", text: "caption" },
      ],
    });
    const t = render([
      ev("turn_context", { turn_id: "turn-image" }),
      imageLine,
      userMsg("[Image #1]caption"),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0]!.block).toBe("UserPromptBlock");
    expect(t[0]!.record.__agentWebuiSourceIndex).toBe(1);
    expect(t[0]!.record.message).toEqual({
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "agent-webui-transcript",
            lineIndex: 1,
            imageIndex: 0,
            media_type: "image/png",
          },
          name: "image-1.png",
        },
        { type: "text", text: "caption" },
      ],
    });
  });

  it("pairs function_call + output into one Bash tool call", () => {
    const t = render([
      fnCall("call_1", "echo hi"),
      fnOut("call_1", "Chunk ID: a\nProcess exited with code 0\nOutput:\nhi\n"),
    ]);
    expect(t.length).toBe(1);
    expect(t[0]!.block).toBe("AssistantBlock");
    expect(t[0]!.toolPairs?.length).toBe(1);
    expect(t[0]!.toolPairs![0]!.use.name).toBe("Bash");
    expect(t[0]!.toolPairs![0]!.use.input.command).toBe("echo hi");
    expect(String(t[0]!.toolPairs![0]!.result)).toContain("hi");
  });

  it("preserves emitted tool-result images as renderable image blocks", () => {
    const t = render([
      fnCall("image_call", "emit image"),
      fnOut("image_call", [
        {
          type: "input_text",
          text: "Chunk ID: image\nProcess exited with code 0\nOutput:\nready",
        },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "original" },
      ]),
    ]);
    expect(t[0]!.toolPairs?.[0]!.result).toEqual([
      { type: "text", text: "ready" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "aGVsbG8=",
        },
      },
    ]);
  });

  it("renders a full turn (user → command → reply) in order", () => {
    const t = render([
      ev("event_msg", { type: "task_started", turn_id: "t1" }),
      userMsg("run echo"),
      fnCall("c1", "echo SMOKE"),
      fnOut("c1", "Output:\nSMOKE\n"),
      ev("event_msg", { type: "token_count", info: {} }),
      agentMsg("DONE"),
      ev("event_msg", { type: "task_complete", turn_id: "t1" }),
    ]);
    expect(t.map((n) => n.block)).toEqual(["UserPromptBlock", "AssistantBlock", "AssistantBlock"]);
    expect(t[1]!.toolPairs?.[0]!.use.name).toBe("Bash");
  });

  it("persists an explicit marker when a turn ends without a final response", () => {
    const t = render([
      userMsg("continue"),
      fnCall("c1", "echo working"),
      fnOut("c1", "Output:\nworking\n"),
      ev("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: null }),
    ]);
    expect(t.map((n) => n.block)).toEqual(["UserPromptBlock", "AssistantBlock", "AssistantBlock"]);
    expect(t[2]!.record.message).toEqual(expect.objectContaining({
      content: [expect.objectContaining({
        type: "text",
        text: "Turn ended without a final response. Send another message to retry or continue.",
      })],
    }));
    expect(codexToClaudeLines(ev("event_msg", {
      type: "task_complete",
      turn_id: "t2",
      last_agent_message: "Done",
    }))).toEqual([]);
  });

  it("replaces an empty-completion marker when a retry attempt starts", () => {
    const t = render([
      userMsg("continue"),
      ev("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: null }),
      ev("event_msg", { type: "task_started", turn_id: "t2" }),
      agentMsg("Completed on retry."),
      ev("event_msg", { type: "task_complete", turn_id: "t2", last_agent_message: "Completed on retry." }),
    ]);
    expect(t.map((node) => node.block)).toEqual(["UserPromptBlock", "AssistantBlock"]);
    expect(t[1]!.record.message).toEqual(expect.objectContaining({
      content: [expect.objectContaining({ type: "text", text: "Completed on retry." })],
    }));
  });

  it("honors rollback markers when rendering append-only rollout logs", () => {
    const t = render([
      userMsg("first"),
      agentMsg("first done"),
      userMsg("second"),
      agentMsg("second done"),
      ev("event_msg", { type: "thread_rolled_back", num_turns: 1 }),
    ]);
    expect(t.map((n) => n.block)).toEqual(["UserPromptBlock", "AssistantBlock"]);
    expect(t[0]!.record.uuid).toBe("codex-line-0");
  });
});
