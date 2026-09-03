import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { hasPendingTurnStart, usePromptPendingStore } from "../src/stores/prompt-pending.js";

describe("pending prompt promotion", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("bridges dispatch and RPC acceptance until a normal turn lands", () => {
    expect(hasPendingTurnStart([{ phase: "sending" }])).toBe(false);
    expect(hasPendingTurnStart([{ phase: "dispatched" }])).toBe(true);
    expect(hasPendingTurnStart([{ phase: "accepted" }])).toBe(true);
    expect(hasPendingTurnStart([{ phase: "accepted", steered: true }])).toBe(false);
  });

  it("preserves the optimistic id and phase when a draft becomes real", () => {
    const pending = usePromptPendingStore();
    const id = pending.add("draft:1", {
      text: "hello",
      imageCount: 0,
      startedAtLineCount: 0,
      agent: "codex",
    });
    pending.markDispatched("draft:1", id);
    const startedAt = pending.pending("draft:1")[0]?.startedAt ?? 0;
    expect(pending.latestStartedAt("draft:1")).toBe(startedAt);

    pending.moveSession("draft:1", "real:1");
    expect(pending.pending("draft:1")).toEqual([]);
    expect(pending.latestStartedAt("draft:1")).toBe(0);
    expect(pending.latestStartedAt("real:1")).toBe(startedAt);
    expect(pending.pending("real:1")).toMatchObject([{ id, phase: "dispatched", text: "hello" }]);

    pending.markAccepted("real:1", id);
    expect(pending.pending("real:1")[0]?.phase).toBe("accepted");
  });

  it("settles only dispatched prompts that precede a durable terminal", () => {
    const pending = usePromptPendingStore();
    const completed = pending.add("session", {
      text: "completed prompt",
      imageCount: 0,
      startedAtLineCount: 10,
      agent: "codex",
      phase: "dispatched",
    });
    const newer = pending.add("session", {
      text: "newer prompt",
      imageCount: 0,
      startedAtLineCount: 21,
      agent: "codex",
      phase: "dispatched",
    });

    pending.settleDispatched("session", { sourceIndex: 20 });

    expect(pending.pending("session").find(item => item.id === completed)?.phase).toBe("accepted");
    expect(pending.pending("session").find(item => item.id === newer)?.phase).toBe("dispatched");
  });
});
