import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const promptInput = readFileSync(join(process.cwd(), "src/components/PromptInput.vue"), "utf8");
const liveStore = readFileSync(join(process.cwd(), "src/stores/live.ts"), "utf8");
const messageList = readFileSync(join(process.cwd(), "src/components/MessageList.vue"), "utf8");
const userPromptBlock = readFileSync(join(process.cwd(), "src/components/blocks/UserPromptBlock.vue"), "utf8");
const pendingReconciliation = readFileSync(
  join(process.cwd(), "src/util/pending-prompt-reconciliation.ts"),
  "utf8",
);

describe("send feedback latency", () => {
  it("locks synchronously before any async send preparation", () => {
    const sendAt = promptInput.indexOf("async function send()");
    const sendOnceAt = promptInput.indexOf("async function sendOnce");
    expect(sendAt).toBeGreaterThan(-1);
    expect(sendOnceAt).toBeGreaterThan(sendAt);
    const wrapper = promptInput.slice(sendAt, sendOnceAt);
    expect(wrapper).toContain("drafts.isInflight(sid)");
    expect(wrapper).toContain("drafts.beginInflight(sid)");
    expect(wrapper.indexOf("drafts.beginInflight(sid)")).toBeLessThan(wrapper.indexOf("await sendOnce(sid)"));
    expect(promptInput).toContain(':disabled="!canSend || isInflightHere"');
  });

  it("paints the optimistic prompt before any provider metadata request", () => {
    const optimisticAt = promptInput.indexOf("pendId = promptPending.add");
    const slashLookupAt = promptInput.indexOf("const slashCommands = await providerSlashCommandsFor");
    expect(optimisticAt).toBeGreaterThan(-1);
    expect(slashLookupAt).toBeGreaterThan(-1);
    expect(optimisticAt).toBeLessThan(slashLookupAt);
    expect(promptInput.slice(optimisticAt, slashLookupAt)).toContain("await nextTick()");
    expect(promptInput).not.toContain("const showOptimistic = !draftCwd");
  });

  it("renders pending sends as real user bubbles before the thinking indicator", () => {
    const pendingBubbleAt = messageList.indexOf('class="cw-message-entry cw-message-entry-pending"');
    const thinkingAt = messageList.indexOf('v-else-if="running || compacting || optimisticallyStarting"');
    expect(pendingBubbleAt).toBeGreaterThan(-1);
    expect(thinkingAt).toBeGreaterThan(-1);
    expect(pendingBubbleAt).toBeLessThan(thinkingAt);
    expect(messageList).toContain('data-block="UserPromptBlock"');
    expect(messageList).toContain("pp.phase === 'sending' ? 'sending'");
    expect(messageList).not.toContain('class="cw-queue-chip cw-queue-chip-optimistic');
    expect(userPromptBlock).toContain('pendingStatus?: "sending" | "steered"');
    expect(userPromptBlock).toContain("cw-pending-prompt-status");
  });

  it("stops showing sending and starts optimistic activity as soon as WebSocket dispatches", () => {
    expect(promptInput).toContain("promptPending.markDispatched(sid, pendId)");
    expect(promptInput).toContain("promptPending.markAccepted(settledSid, pendId)");
    expect(promptInput).toMatch(
      /const markDispatched = \(\) => \{[\s\S]*?drafts\.clearIfMatches\(sid, snapText\)[\s\S]*?imageDrafts\.take\(sid, snapImageIds\)/,
    );
    expect(promptInput).toMatch(
      /catch \(err\) \{[\s\S]*?drafts\.restoreBefore\(settledSid, snapText\)[\s\S]*?imageDrafts\.restore\(settledSid, removedImagesOnDispatch\)/,
    );
    expect(promptInput).not.toContain("imageDrafts.clear(sid)");
    expect(promptInput).toContain("sessions.resolvePromoted(sid)");
    expect(liveStore).toContain("usePromptPendingStore().moveSession(draftId, sessionId)");
    expect(liveStore).toContain("useDraftsStore().moveSession(draftId, sessionId)");
    expect(liveStore).toContain("sessions.recordPromotion(draftId, sessionId)");
    expect(messageList).toContain('prompt.phase === "dispatched"');
    expect(messageList).toContain("running || compacting || optimisticallyStarting");
  });

  it("reconciles Codex bubbles by client id, with a bounded legacy fallback", () => {
    expect(pendingReconciliation).toContain("record.clientId === entry.id");
    expect(pendingReconciliation).toContain("record.index >= entry.startedAtLineCount");
    expect(messageList).toContain("pendingPromptProbeRange(entry, firstLoadedIndex)");
    expect(messageList).toContain("readSessionRange(props.sessionId, range.from, range.to)");
    expect(messageList).toContain("const pendingLandingSignal = computed");
    expect(messageList).not.toContain("watch(() => lines.value.length");
    expect(promptInput).toContain("sessionState?.nextLineIndex");
  });

  it("uses the optimistic id as the retry-deduplication key", () => {
    expect(promptInput).toMatch(/sendPrompt\([\s\S]*?pendId \?\? undefined,[\s\S]*?slashCommands,/);
    expect(promptInput).toContain('retrying. Your text is kept.');
    expect(promptInput).toContain('"Send not confirmed"');
  });

  it("advances the source cursor from WS liveness and HTTP tail truth", () => {
    expect(liveStore).toContain('if (type === "stream-cursor")');
    expect(liveStore).toContain("cache.advanceCursor(id, nextIndex)");
    expect(liveStore).toContain("cache.advanceCursor(id, tail.totalLines)");
  });
});
