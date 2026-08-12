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

  it("locks a continuation draft and does not hijack later navigation on failure", () => {
    const contextFooter = source("src/components/blocks/ContextFooter.vue");
    const lockAt = contextFooter.indexOf("drafts.beginInflight(draftId)");
    const selectAt = contextFooter.indexOf("ui.select(draftId)");
    const requestAt = contextFooter.indexOf("const created = await newSession");

    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(selectAt);
    expect(selectAt).toBeLessThan(requestAt);
    expect(contextFooter).toContain("drafts.endInflight(sessions.resolvePromoted(draftId))");
    expect(contextFooter).toContain("if (ui.selectedSessionId === draftId) ui.select(oldSessionId)");
    expect(contextFooter).not.toMatch(/sessions\.dropPending\(draftId\);\s*ui\.select\(oldSessionId\)/);
  });

  it("uses the modal optimistic id as a stable retry key and promotes it", () => {
    const modal = source("src/components/modals/NewSessionModal.vue");
    expect(modal).toContain("const clientUuid = sessions.newSessionClientUuid(");
    expect(modal).toContain("pendingId,");
    expect(modal).toContain("promotePendingDraft(draftId, created.sessionId)");
    expect(modal).toContain("promptPending.markAccepted(created.sessionId, pendingId)");
    expect(modal).toContain("drafts.set(draftId, promptText)");
  });

  it("shows the modal's first prompt before starting the backend session", () => {
    const modal = source("src/components/modals/NewSessionModal.vue");
    const optimisticAt = modal.indexOf("pendingId = promptPending.add");
    const selectAt = modal.indexOf("ui.select(draftId)", optimisticAt);
    const requestAt = modal.indexOf("const created = await newSession");

    expect(optimisticAt).toBeGreaterThan(-1);
    expect(selectAt).toBeGreaterThan(optimisticAt);
    expect(requestAt).toBeGreaterThan(selectAt);
    expect(modal.slice(optimisticAt, requestAt)).toContain('emit("close")');
    expect(modal).toContain("promptPending.markDispatched(draftId, pendingId)");
  });

  it("never assigns a same-cwd session-added event to the selected draft", () => {
    const live = source("src/stores/live.ts");
    expect(live).toContain("export function promotePendingDraft");
    expect(live).not.toContain("draft.cwd === cwd");
    expect(live).not.toContain("promptPending.moveSession(selected, newId)");
  });
});
