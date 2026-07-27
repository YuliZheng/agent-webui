import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("new-session idempotency wiring", () => {
  it("persists a stable key for retrying a pending draft's first send", () => {
    const promptInput = source("src/components/PromptInput.vue");
    expect(promptInput).toContain("sessions.newSessionClientUuid(");
    expect(promptInput).toContain("clientUuid,");
    expect(promptInput).toContain("promotePendingDraft(sid, created.sessionId)");
  });

  it("retains the continuation key across an outcome-unknown retry", () => {
    const contextFooter = source("src/components/blocks/ContextFooter.vue");
    expect(contextFooter).toContain("continuationFingerprint !== fingerprint");
    expect(contextFooter).toContain("clientUuid: continuationClientUuid");
    expect(contextFooter).toContain("promotePendingDraft(draftId, created.sessionId)");
  });

  it("retains the modal key for the same payload and clears it after success", () => {
    const modal = source("src/components/modals/NewSessionModal.vue");
    expect(modal).toContain("retryFingerprint !== fingerprint");
    expect(modal).toContain("const clientUuid = clientUuidFor(cwdResolved, prompt.value, agent.value)");
    expect(modal).toMatch(/await newSession\([\s\S]*?clientUuid,[\s\S]*?\);\s*clearRetryClientUuid\(\)/);
  });

  it("never assigns a same-cwd session-added event to the selected draft", () => {
    const live = source("src/stores/live.ts");
    expect(live).toContain("export function promotePendingDraft");
    expect(live).not.toContain("draft.cwd === cwd");
    expect(live).not.toContain("promptPending.moveSession(selected, newId)");
  });
});
