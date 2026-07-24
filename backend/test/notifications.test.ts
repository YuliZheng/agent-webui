import { describe, expect, it } from "vitest";
import { isMeaningfulEndTurnRecord, NotificationDeduper } from "../src/services/notifications.js";

describe("end-turn notification filtering", () => {
  it("drops empty/sidechain Claude placeholders but keeps meaningful completions", () => {
    expect(isMeaningfulEndTurnRecord({ type: "assistant", message: { stop_reason: "end_turn", content: [] } }, "claude")).toBe(false);
    expect(isMeaningfulEndTurnRecord({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "  " }] } }, "claude")).toBe(false);
    expect(isMeaningfulEndTurnRecord({ type: "assistant", isSidechain: true, message: { stop_reason: "end_turn", content: [{ type: "text", text: "noise" }] } }, "claude")).toBe(false);
    expect(isMeaningfulEndTurnRecord({ type: "assistant", agentId: "sub", message: { stop_reason: "end_turn", content: [{ type: "text", text: "noise" }] } }, "claude")).toBe(false);
    expect(isMeaningfulEndTurnRecord({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] } }, "claude")).toBe(true);
    expect(isMeaningfulEndTurnRecord({ type: "event_msg", payload: { type: "turn_complete" } }, "codex")).toBe(true);
  });
  it("deduplicates with a bounded true LRU", () => {
    const seen = new NotificationDeduper(2);
    expect(seen.seen("a")).toBe(false); expect(seen.seen("b")).toBe(false); expect(seen.seen("a")).toBe(true);
    expect(seen.seen("c")).toBe(false); expect(seen.size).toBe(2); expect(seen.seen("b")).toBe(false);
  });
});
