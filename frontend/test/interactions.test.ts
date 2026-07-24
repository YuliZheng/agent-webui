import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { answerInteractionOnce, interactionQuestions, interactionToolSummary } from "@/util/interactions";
import { useInteractionsStore } from "@/stores/sessions";

beforeEach(() => setActivePinia(createPinia()));

describe("interaction normalization", () => {
  it("keeps AskUserQuestion choices and descriptions", () => {
    expect(interactionQuestions({ sessionId: "s", requestId: "r", kind: "question", questions: [{ header: "Deploy", question: "Where?", options: [{ label: "Local", description: "this machine" }] }] }))
      .toEqual([{ key: "Deploy", question: "Where?", options: [{ label: "Local", description: "this machine", value: "Local" }], multiSelect: false }]);
  });
  it("shows permission tool name and structured input", () => {
    expect(interactionToolSummary({ sessionId: "s", requestId: "r", kind: "permission", toolName: "Bash", input: { command: "npm test" } }))
      .toMatchObject({ name: "Bash", input: expect.stringContaining("npm test") });
  });
  it("allows only the first answer while an interaction response is in flight", async () => {
    const interaction = { sessionId: "once", requestId: "request", kind: "permission" as const };
    let release!: () => void;
    const respond = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = answerInteractionOnce(interaction, true, respond);
    await expect(answerInteractionOnce(interaction, false, respond)).resolves.toBe(false);
    expect(respond).toHaveBeenCalledTimes(1);
    release(); await expect(first).resolves.toBe(true);
    respond.mockImplementation(() => Promise.resolve());
    await expect(answerInteractionOnce(interaction, true, respond)).resolves.toBe(true);
    expect(respond).toHaveBeenCalledTimes(2);
  });
  it("keys pending interactions by both session and request id", () => {
    const store = useInteractionsStore();
    store.add({ sessionId: "a", requestId: "same", kind: "permission" });
    store.add({ sessionId: "b", requestId: "same", kind: "permission" });
    expect(store.items).toHaveLength(2);
    store.remove("a", "same");
    expect(store.items).toEqual([expect.objectContaining({ sessionId: "b", requestId: "same" })]);
  });
});
