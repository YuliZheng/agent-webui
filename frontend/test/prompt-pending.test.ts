import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { usePromptPendingStore } from "../src/stores/prompt-pending.js";

describe("pending prompt promotion", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
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

    pending.moveSession("draft:1", "real:1");
    expect(pending.pending("draft:1")).toEqual([]);
    expect(pending.pending("real:1")).toMatchObject([{ id, phase: "dispatched", text: "hello" }]);

    pending.markAccepted("real:1", id);
    expect(pending.pending("real:1")[0]?.phase).toBe("accepted");
  });
});
