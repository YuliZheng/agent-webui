import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useLiveStore } from "../src/stores/live.js";
import { useSessionsStore } from "../src/stores/sessions.js";
import { usePromptPendingStore } from "../src/stores/prompt-pending.js";
import { useUiStore } from "../src/stores/ui.js";

describe("live assistant preview unread", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("marks a background session unread on first visible assistant preview only", () => {
    const id = `background-${Math.random()}`;
    const sessions = useSessionsStore();
    const live = useLiveStore();
    useUiStore().selectFromHistory("another-session");
    sessions.addOrTouch({
      id,
      cwd: "C:\\repo",
      mtime: "2026-08-01T00:00:00.000Z",
      size: 10,
      agent: "codex",
      preview: "question",
      previewRole: "user",
      lastTurnAt: "2026-08-01T00:00:00.000Z",
    });

    live.onGlobal({
      kind: "session-touched", id, cwd: "C:\\repo", agent: "codex",
      mtime: "2026-08-01T00:00:01.000Z", size: 20,
      preview: "first answer", previewRole: "assistant",
      lastTurnAt: "2026-08-01T00:00:01.000Z",
    });
    live.onGlobal({
      kind: "session-touched", id, cwd: "C:\\repo", agent: "codex",
      mtime: "2026-08-01T00:00:02.000Z", size: 30,
      preview: "streamed answer update", previewRole: "assistant",
      lastTurnAt: "2026-08-01T00:00:02.000Z",
    });
    expect(sessions.unreadBySession[id]).toBe(1);

    // The normal end-turn notification must not count the same reply twice.
    live.onGlobal({ kind: "notification", id, body: "" });
    expect(sessions.unreadBySession[id]).toBe(1);
  });

  it("does not mark the currently open session unread", () => {
    const id = `foreground-${Math.random()}`;
    const sessions = useSessionsStore();
    useUiStore().selectFromHistory(id);
    sessions.addOrTouch({
      id, cwd: "C:\\repo", mtime: "2026-08-01T00:00:00.000Z",
      size: 10, agent: "codex", preview: "question", previewRole: "user",
    });
    useLiveStore().onGlobal({
      kind: "session-touched", id, cwd: "C:\\repo", agent: "codex",
      mtime: "2026-08-01T00:00:01.000Z", size: 20,
      preview: "answer", previewRole: "assistant",
    });
    expect(sessions.unreadBySession[id]).toBeUndefined();
  });

  it("marks the selected session unread and notifies when the app is unfocused", async () => {
    const id = `selected-background-${Math.random()}`;
    const sessions = useSessionsStore();
    useUiStore().selectFromHistory(id);
    sessions.addOrTouch({
      id, cwd: "C:\\repo", mtime: "2026-08-01T00:00:00.000Z",
      size: 10, agent: "codex", preview: "question", previewRole: "user",
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);

    const close = vi.fn();
    const NotificationMock = vi.fn(function (this: { onclick: (() => void) | null; close: () => void }) {
      this.onclick = null;
      this.close = close;
    });
    Object.assign(NotificationMock, { permission: "granted" });
    vi.stubGlobal("Notification", NotificationMock);

    useLiveStore().onGlobal({
      kind: "notification", id, body: "finished answer", title: "Agent WebUI",
      timestamp: "2026-08-01T00:00:01.000Z",
    });

    expect(sessions.unreadBySession[id]).toBe(1);
    await vi.waitFor(() => expect(NotificationMock).toHaveBeenCalledTimes(1));
  });

  it("does not treat a repeated old assistant preview after send as a new reply", () => {
    const id = `outbound-${Math.random()}`;
    const sessions = useSessionsStore();
    const live = useLiveStore();
    const pending = usePromptPendingStore();
    useUiStore().selectFromHistory("temporary-history-selection");
    sessions.addOrTouch({
      id, cwd: "C:\\repo", mtime: "2026-08-01T00:00:00.000Z",
      size: 10, agent: "codex", preview: "previous answer", previewRole: "assistant",
      lastTurnAt: "2026-08-01T00:00:00.000Z",
    });
    pending.add(id, {
      text: "my next question",
      imageCount: 0,
      startedAtLineCount: 10,
      startedAtSessionSize: 10,
      agent: "codex",
      phase: "dispatched",
    });

    // The file grew for our outbound record, but the index can briefly repeat
    // the previous assistant preview until the user record is parsed.
    live.onGlobal({
      kind: "session-touched", id, cwd: "C:\\repo", agent: "codex",
      mtime: "2026-08-01T00:00:01.000Z", size: 20,
      preview: "previous answer", previewRole: "assistant",
      lastTurnAt: "2026-08-01T00:00:00.000Z",
    });
    expect(sessions.unreadBySession[id]).toBeUndefined();

    live.onGlobal({
      kind: "session-touched", id, cwd: "C:\\repo", agent: "codex",
      mtime: "2026-08-01T00:00:02.000Z", size: 30,
      preview: "my next question", previewRole: "user",
      lastTurnAt: "2026-08-01T00:00:02.000Z",
    });
    expect(sessions.unreadBySession[id]).toBeUndefined();
  });

  it("does not mistake a stale background subscription for an actively viewed session", () => {
    const id = `engaged-${Math.random()}`;
    const sessions = useSessionsStore();
    const live = useLiveStore();
    useUiStore().selectFromHistory("temporary-history-selection");
    sessions.addOrTouch({
      id, cwd: "C:\\repo", mtime: "2026-08-01T00:00:00.000Z",
      size: 10, agent: "codex", preview: "question", previewRole: "user",
      lastTurnAt: "2026-08-01T00:00:00.000Z",
    });
    live.perSession[id] = () => undefined;

    live.onGlobal({
      kind: "session-touched", id, cwd: "C:\\repo", agent: "codex",
      mtime: "2026-08-01T00:00:01.000Z", size: 20,
      preview: "new answer", previewRole: "assistant",
      lastTurnAt: "2026-08-01T00:00:01.000Z",
    });
    expect(sessions.unreadBySession[id]).toBe(1);
  });

  it("clears an already-added local badge when completion lands in the open session", () => {
    const id = `completion-${Math.random()}`;
    const sessions = useSessionsStore();
    const live = useLiveStore();
    useUiStore().selectFromHistory(id);
    sessions.addOrTouch({
      id, cwd: "C:\\repo", mtime: "2026-08-01T00:00:00.000Z",
      size: 10, agent: "codex", preview: "question", previewRole: "user",
      lastTurnAt: "2026-08-01T00:00:00.000Z",
    });
    sessions.bumpUnread(id);

    live.onGlobal({
      kind: "notification", id, body: "finished answer",
      timestamp: "2026-08-01T00:00:01.000Z",
    });
    expect(sessions.unreadBySession[id]).toBeUndefined();
  });

  it("ignores a delayed completion already covered by the outbound read watermark", () => {
    const id = `delayed-completion-${Math.random()}`;
    const sessions = useSessionsStore();
    useUiStore().selectFromHistory("another-session");
    sessions.addOrTouch({
      id, cwd: "C:\\repo", mtime: "2026-08-01T00:00:02.000Z",
      size: 30, agent: "codex", preview: "my newer question", previewRole: "user",
      lastTurnAt: "2026-08-01T00:00:02.000Z",
      readAt: "2026-08-01T00:00:01.000Z",
    });

    useLiveStore().onGlobal({
      kind: "notification", id, body: "the previous answer",
      timestamp: "2026-08-01T00:00:01.000Z",
    });

    expect(sessions.unreadBySession[id]).toBeUndefined();
    expect(sessions.byId[id]?.preview).toBe("my newer question");
    expect(sessions.byId[id]?.previewRole).toBe("user");
    expect(sessions.byId[id]?.lastTurnAt).toBe("2026-08-01T00:00:02.000Z");
    expect(sessions.byId[id]?.readAt).toBe("2026-08-01T00:00:01.000Z");
  });

  it("clears stale unread when an outbound user record lands in the background", () => {
    const id = `background-user-${Math.random()}`;
    const sessions = useSessionsStore();
    useUiStore().selectFromHistory("another-session");
    sessions.addOrTouch({
      id, cwd: "C:\\repo", mtime: "2026-08-01T00:00:00.000Z",
      size: 10, agent: "codex", preview: "old answer", previewRole: "assistant",
      lastTurnAt: "2026-08-01T00:00:00.000Z",
    });
    sessions.bumpUnread(id);

    useLiveStore().onGlobal({
      kind: "session-touched", id, cwd: "C:\\repo", agent: "codex",
      mtime: "2026-08-01T00:00:02.000Z", size: 30,
      preview: "my outgoing message", previewRole: "user",
      lastTurnAt: "2026-08-01T00:00:02.000Z",
    });

    expect(sessions.unreadBySession[id]).toBeUndefined();
    expect(sessions.byId[id]?.readAt).toBe("2026-08-01T00:00:02.000Z");
  });

  it("keeps a newer assistant unread when an older user touch arrives late", () => {
    const id = `late-user-touch-${Math.random()}`;
    const sessions = useSessionsStore();
    useUiStore().selectFromHistory("another-session");
    sessions.addOrTouch({
      id, cwd: "C:\\repo", mtime: "2026-08-01T00:00:01.000Z",
      size: 10, agent: "codex", preview: "older question", previewRole: "user",
      lastTurnAt: "2026-08-01T00:00:01.000Z",
    });

    useLiveStore().onGlobal({
      kind: "session-touched", id, cwd: "C:\\repo", agent: "codex",
      mtime: "2026-08-01T00:00:03.000Z", size: 50,
      preview: "new assistant answer", previewRole: "assistant",
      lastTurnAt: "2026-08-01T00:00:03.000Z",
    });
    expect(sessions.unreadBySession[id]).toBe(1);

    useLiveStore().onGlobal({
      kind: "session-touched", id, cwd: "C:\\repo", agent: "codex",
      mtime: "2026-08-01T00:00:02.000Z", size: 30,
      preview: "late older question", previewRole: "user",
      lastTurnAt: "2026-08-01T00:00:02.000Z",
    });

    expect(sessions.byId[id]?.preview).toBe("new assistant answer");
    expect(sessions.byId[id]?.previewRole).toBe("assistant");
    expect(sessions.byId[id]?.lastTurnAt).toBe("2026-08-01T00:00:03.000Z");
    expect(sessions.unreadBySession[id]).toBe(1);

    // The assistant touch already accounted for this completion. The stale
    // user event must not discard that de-duplication guard and bump twice.
    useLiveStore().onGlobal({
      kind: "notification", id, body: "new assistant answer",
      timestamp: "2026-08-01T00:00:03.000Z",
    });
    expect(sessions.unreadBySession[id]).toBe(1);
  });

  it("never regresses a newer read watermark for a selected session", () => {
    const id = `read-watermark-${Math.random()}`;
    const sessions = useSessionsStore();
    useUiStore().selectFromHistory(id);
    sessions.addOrTouch({
      id, cwd: "C:\\repo", mtime: "2026-08-01T00:00:02.000Z",
      size: 30, agent: "codex", preview: "newer turn", previewRole: "user",
      lastTurnAt: "2026-08-01T00:00:02.000Z",
      readAt: "2026-08-01T00:00:02.000Z",
    });

    useLiveStore().onGlobal({
      kind: "notification", id, body: "older completion",
      timestamp: "2026-08-01T00:00:01.000Z",
    });

    expect(sessions.byId[id]?.readAt).toBe("2026-08-01T00:00:02.000Z");
    expect(sessions.byId[id]?.preview).toBe("newer turn");
    expect(sessions.unreadBySession[id]).toBeUndefined();
  });

  it("persists the completion body as the assistant sidebar preview", () => {
    const id = `completed-${Math.random()}`;
    const sessions = useSessionsStore();
    sessions.addOrTouch({
      id, cwd: "C:\\repo", mtime: "2026-08-01T00:00:00.000Z",
      size: 10, agent: "codex", preview: "继续?", previewRole: "user",
    });

    useLiveStore().onGlobal({
      kind: "notification",
      id,
      body: "已经完成登录状态检查。",
      timestamp: "2026-08-01T00:00:02.000Z",
    });

    expect(sessions.byId[id]?.preview).toBe("已经完成登录状态检查。");
    expect(sessions.byId[id]?.previewRole).toBe("assistant");
    expect(sessions.byId[id]?.lastTurnAt).toBe("2026-08-01T00:00:02.000Z");
  });

  it("hydrates the server-authoritative unread count after another device was offline", () => {
    const id = `global-unread-${Math.random()}`;
    const sessions = useSessionsStore();
    sessions.addOrTouch({
      id, cwd: "C:\\repo", mtime: "2026-08-29T10:00:02.000Z",
      size: 20, agent: "codex", preview: "answer", previewRole: "assistant",
      lastTurnAt: "2026-08-29T10:00:02.000Z",
    });
    sessions.bumpUnread(id);
    sessions.bumpUnread(id);

    sessions.hydrateList([{
      id, cwd: "C:\\repo", mtime: "2026-08-29T10:00:02.000Z",
      size: 20, agent: "codex", preview: "answer", previewRole: "assistant",
      lastTurnAt: "2026-08-29T10:00:02.000Z", unreadCount: 1,
    }]);
    expect(sessions.unreadBySession[id]).toBe(1);

    sessions.hydrateList([{
      id, cwd: "C:\\repo", mtime: "2026-08-29T10:00:02.000Z",
      size: 20, agent: "codex", preview: "answer", previewRole: "assistant",
      lastTurnAt: "2026-08-29T10:00:02.000Z",
      readAt: "2026-08-29T10:00:02.000Z", unreadCount: 3,
    }]);
    expect(sessions.unreadBySession[id]).toBeUndefined();
  });

  it("applies an exact cross-device unread count and clears it globally", () => {
    const id = `global-read-event-${Math.random()}`;
    const sessions = useSessionsStore();
    const live = useLiveStore();
    useUiStore().selectFromHistory("another-session");
    sessions.addOrTouch({
      id, cwd: "C:\\repo", mtime: "2026-08-29T10:00:03.000Z",
      size: 30, agent: "codex", preview: "answer", previewRole: "assistant",
      lastTurnAt: "2026-08-29T10:00:03.000Z", unreadCount: 2,
    });
    expect(sessions.unreadBySession[id]).toBe(2);

    live.onGlobal({
      kind: "session-read",
      id,
      at: "2026-08-29T10:00:03.000Z",
      unreadCount: 0,
    });
    expect(sessions.unreadBySession[id]).toBeUndefined();
    expect(sessions.byId[id]?.readAt).toBe("2026-08-29T10:00:03.000Z");
  });
});
