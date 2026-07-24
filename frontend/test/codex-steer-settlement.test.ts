import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { promptChips } from "@/persist/drafts";
import { useComposerStore } from "@/stores/composer";
import { useLiveStore } from "@/stores/live";

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});

describe("Codex steer settlement push", () => {
  it("keeps a steer through interruption/crash status and clears it only on the settlement event", () => {
    const sessionId = `codex-settle-${crypto.randomUUID()}`;
    const chip = promptChips.add(sessionId, {
      text: "change direction",
      imageCount: 0,
      startLine: 12,
      agent: "codex",
      state: "steered",
      steered: true
    });
    const composer = useComposerStore();
    composer.ensure(sessionId);
    const live = useLiveStore();

    live.onPush({ type: "session-status", kind: "session-status", sessionId, status: "failed" });
    live.onPush({ type: "turn/completed", sessionId, status: "interrupted" });
    expect(composer.chips[sessionId]?.map((item) => item.id)).toContain(chip.id);

    live.onPush({
      type: "codex-steers-settled",
      kind: "codex-steers-settled",
      sessionId,
      status: "completed",
      clientUuids: [chip.id]
    });
    expect(composer.chips[sessionId]).toEqual([]);
  });

  it("ignores malformed IDs and never clears non-steered prompts", () => {
    const sessionId = `codex-normal-${crypto.randomUUID()}`;
    const chip = promptChips.add(sessionId, {
      text: "new turn",
      imageCount: 0,
      startLine: 0,
      agent: "codex",
      state: "sending",
      steered: false
    });
    const composer = useComposerStore();
    composer.ensure(sessionId);

    useLiveStore().onPush({
      type: "codex-steers-settled",
      sessionId,
      clientUuids: [null, 123, chip.id]
    });
    expect(composer.chips[sessionId]?.map((item) => item.id)).toEqual([chip.id]);
  });
});
