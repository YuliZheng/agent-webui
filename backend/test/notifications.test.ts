import { describe, expect, it } from "vitest";
import { codexDurableTerminal, isMeaningfulEndTurnRecord, NotificationDeduper } from "../src/services/notifications.js";

describe("end-turn notification filtering", () => {
  it("drops empty/sidechain Claude placeholders but keeps meaningful completions", () => {
    expect(isMeaningfulEndTurnRecord({ type: "assistant", message: { stop_reason: "end_turn", content: [] } }, "claude")).toBe(false);
    expect(isMeaningfulEndTurnRecord({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "  " }] } }, "claude")).toBe(false);
    expect(isMeaningfulEndTurnRecord({ type: "assistant", isSidechain: true, message: { stop_reason: "end_turn", content: [{ type: "text", text: "noise" }] } }, "claude")).toBe(false);
    expect(isMeaningfulEndTurnRecord({ type: "assistant", agentId: "sub", message: { stop_reason: "end_turn", content: [{ type: "text", text: "noise" }] } }, "claude")).toBe(false);
    expect(isMeaningfulEndTurnRecord({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] } }, "claude")).toBe(true);
    expect(isMeaningfulEndTurnRecord({ type: "event_msg", payload: { type: "turn_complete" } }, "codex")).toBe(true);
    expect(isMeaningfulEndTurnRecord({ type: "event_msg", payload: { type: "task_complete", last_agent_message: null } }, "codex")).toBe(false);
    expect(isMeaningfulEndTurnRecord({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "  " } }, "codex")).toBe(false);
    expect(isMeaningfulEndTurnRecord({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Done" } }, "codex")).toBe(true);
  });
  it("deduplicates with a bounded true LRU", () => {
    const seen = new NotificationDeduper(2);
    expect(seen.seen("a")).toBe(false); expect(seen.seen("b")).toBe(false); expect(seen.seen("a")).toBe(true);
    expect(seen.seen("c")).toBe(false); expect(seen.size).toBe(2); expect(seen.seen("b")).toBe(false);
  });
  it("recognizes durable Codex terminals independently of visible reply text", () => {
    expect(codexDurableTerminal({
      timestamp: "2026-01-02T03:04:05Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-a", last_agent_message: null },
    })).toEqual({
      kind: "completed",
      timestamp: "2026-01-02T03:04:05Z",
      turnId: "turn-a",
    });
    expect(codexDurableTerminal({
      type: "event_msg",
      payload: { type: "turn_aborted", turn_id: "turn-b" },
    })).toEqual({ kind: "interrupted", timestamp: undefined, turnId: "turn-b" });
    expect(codexDurableTerminal({
      type: "event_msg",
      payload: { type: "task_complete" },
    })).toBeNull();
  });
});
