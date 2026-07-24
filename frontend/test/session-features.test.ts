import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "@vue/test-utils";
import OverlayHost from "@/components/OverlayHost.vue";
import { MAX_ATTACHMENT_BYTES, promptAttachmentKey, validateAttachment } from "@/stores/composer";
import { useUiStore } from "@/stores/ui";
import { parseCodexGoalFields } from "@/util/codex-goal";

beforeEach(() => setActivePinia(createPinia()));

describe("session-level controls", () => {
  it("accepts images and PDFs and reports the 10 MiB boundary", () => {
    expect(validateAttachment({ size: MAX_ATTACHMENT_BYTES, type: "image/png" })).toBeNull();
    expect(validateAttachment({ size: 10, type: "application/pdf" })).toBeNull();
    expect(validateAttachment({ size: MAX_ATTACHMENT_BYTES + 1, type: "image/jpeg" })).toBe("too-large");
    expect(validateAttachment({ size: 10, type: "text/plain" })).toBe("unsupported");
    expect(promptAttachmentKey("chip-a", 2)).toBe("prompt:chip-a:2");
  });

  it("builds top-level Codex goal fields from plain text or JSON", () => {
    expect(parseCodexGoalFields("ship the release")).toEqual({ objective: "ship the release", status: "active" });
    expect(parseCodexGoalFields('{"objective":"ship","status":"blocked","tokenBudget":1200}')).toEqual({ objective: "ship", status: "blocked", tokenBudget: 1200 });
    expect(parseCodexGoalFields('{"goal":"nested"}')).toBeNull();
  });

  it("keeps background interaction toasts until explicitly handled", () => {
    vi.useFakeTimers();
    const ui = useUiStore();
    ui.showInteractionToast({ sessionId: "background", requestId: "permission-1", kind: "permission", toolName: "Bash" });
    vi.advanceTimersByTime(60_000);
    expect(ui.toasts).toHaveLength(1);
    expect(ui.toasts[0]).toMatchObject({ sticky: true, sessionId: "background", requestId: "permission-1" });
    ui.dismissInteractionToast("background", "permission-1");
    expect(ui.toasts).toHaveLength(0);
    vi.useRealTimers();
  });

  it("keeps selected/off-screen interactions actionable and removes stale cards", () => {
    const ui = useUiStore();
    const first = { sessionId: "selected", requestId: "question-1", kind: "question" as const };
    ui.syncInteractionToasts([first]);
    expect(ui.toasts).toHaveLength(1);
    ui.syncInteractionToasts([]);
    expect(ui.toasts).toHaveLength(0);
  });

  it("opens and dismisses a session notification when its toast is clicked", async () => {
    const ui = useUiStore();
    ui.toast("Agent finished", "info", { sessionId: "target-session" });
    mount(OverlayHost, { attachTo: document.body });

    const toast = document.body.querySelector<HTMLElement>(".cw-toast.actionable");
    expect(toast?.getAttribute("role")).toBe("button");
    toast?.click();

    expect(ui.openSessionRequest?.sessionId).toBe("target-session");
    expect(ui.toasts).toHaveLength(0);
  });

  it("wires fork navigation, inline interactions, task details and todo checklist", () => {
    const app = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");
    const transcript = readFileSync(join(process.cwd(), "src/components/TranscriptPane.vue"), "utf8");
    const tool = readFileSync(join(process.cwd(), "src/components/blocks/ToolBlock.vue"), "utf8");
    const header = readFileSync(join(process.cwd(), "src/components/SessionHeader.vue"), "utf8");
    expect(transcript).toContain('emit("forked", { newSessionId: data.newSessionId');
    expect(app).toContain('@forked="handleFork"');
    expect(app.indexOf("await sessions.refresh();", app.indexOf("async function handleFork"))).toBeLessThan(app.indexOf("composer.setText(data.newSessionId", app.indexOf("async function handleFork")));
    expect(tool).toContain('<InteractionTray v-if="interactions.length"');
    expect(transcript).toContain("emit('retryChip', chip)");
    expect(transcript).toContain("emit('dismissChip', chip.id)");
    expect(header).toContain("cw-task-modal");
    expect(app).toContain("cw-todo-modal");
  });
});
