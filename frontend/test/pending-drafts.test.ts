import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useSessionsStore } from "../src/stores/sessions.js";
import { usePromptPendingStore } from "../src/stores/prompt-pending.js";
import { useUiStore } from "../src/stores/ui.js";
import { promotePendingDraft } from "../src/stores/live.js";

const KEY = "cw:pendingDrafts:v1";
const SESSION_LIST_KEY = "cw:sessions:v1";

describe("pending drafts persistence", () => {
  beforeEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("restores recent session metadata immediately without stale process status", () => {
    localStorage.setItem(SESSION_LIST_KEY, JSON.stringify([{
      id: "cached-session",
      cwd: "/home/cached",
      mtime: "2026-08-19T00:00:00.000Z",
      size: 42,
      agent: "codex",
      status: "running",
      preview: "cached preview",
    }]));
    setActivePinia(createPinia());

    const sessions = useSessionsStore();
    expect(sessions.loaded).toBe(true);
    expect(sessions.byId["cached-session"]).toMatchObject({
      cwd: "/home/cached",
      preview: "cached preview",
    });
    expect(sessions.byId["cached-session"]?.status).toBeUndefined();
  });

  it("createPending writes the draft to localStorage", () => {
    const s = useSessionsStore();
    const id = s.createPending("/home/foo", "codex");
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(stored[id]).toMatchObject({ cwd: "/home/foo", agent: "codex" });
  });

  it("restores drafts into list/byId on store init", () => {
    const s1 = useSessionsStore();
    const id = s1.createPending("/home/foo");
    // Fresh pinia simulates a page reload.
    setActivePinia(createPinia());
    const s2 = useSessionsStore();
    expect(s2.isPending(id)).toBe(true);
    expect(s2.byId[id]?.cwd).toBe("/home/foo");
    expect(s2.list.some((r) => r.id === id)).toBe(true);
  });

  it("hydrateList keeps drafts alongside backend sessions", () => {
    const s = useSessionsStore();
    const id = s.createPending("/home/foo");
    s.hydrateList([
      { id: "real1", cwd: "/home/bar", mtime: new Date().toISOString(), size: 1, title: null, parentSessionId: null },
    ]);
    expect(s.byId[id]).toBeTruthy();
    expect(s.byId["real1"]).toBeTruthy();
    expect(s.list).toHaveLength(2);
  });

  it("setPendingSettings stashes and clears model/permission/service-tier picks", () => {
    const s = useSessionsStore();
    const id = s.createPending("/home/foo");
    s.setPendingSettings(id, { model: "claude-opus-4-8", permissionMode: "plan", effort: "high", serviceTier: "priority" });
    expect(s.pendingDrafts[id]).toMatchObject({
      model: "claude-opus-4-8",
      permissionMode: "plan",
      effort: "high",
      serviceTier: "priority",
    });
    // Empty string = back to default → key dropped.
    s.setPendingSettings(id, { model: "" });
    expect(s.pendingDrafts[id]?.model).toBeUndefined();
    expect(s.pendingDrafts[id]?.permissionMode).toBe("plan");
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(stored[id].model).toBeUndefined();
    expect(stored[id].permissionMode).toBe("plan");
    expect(stored[id].serviceTier).toBe("priority");

    // Fast-off is explicit rather than "inherit default", so it must persist.
    s.setPendingSettings(id, { serviceTier: "" });
    expect(s.pendingDrafts[id]?.serviceTier).toBe("");
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")[id].serviceTier).toBe("");

    setActivePinia(createPinia());
    const restored = useSessionsStore();
    expect(restored.pendingDrafts[id]).toMatchObject({ effort: "high", serviceTier: "" });
  });

  it("dropPending removes the draft from storage", () => {
    const s = useSessionsStore();
    const id = s.createPending("/home/foo");
    s.dropPending(id);
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(stored[id]).toBeUndefined();
    expect(s.byId[id]).toBeUndefined();
  });

  it("persists and reuses the first-send idempotency key until the payload changes", () => {
    const s = useSessionsStore();
    const id = s.createPending("/home/foo", "codex");
    expect(s.newSessionClientUuid(id, "payload-a", "key-a")).toBe("key-a");
    expect(s.newSessionClientUuid(id, "payload-a", "key-b")).toBe("key-a");
    expect(s.newSessionClientUuid(id, "payload-b", "key-b")).toBe("key-b");

    setActivePinia(createPinia());
    const restored = useSessionsStore();
    expect(restored.pendingDrafts[id]).toMatchObject({
      clientUuid: "key-b",
      clientFingerprint: "payload-b",
    });
  });

  it("records where an in-flight draft was promoted", () => {
    const s = useSessionsStore();
    const id = s.createPending("/home/foo", "codex");
    s.recordPromotion(id, "real-session");
    s.dropPending(id);

    expect(s.resolvePromoted(id)).toBe("real-session");
    expect(s.resolvePromoted("real-session")).toBe("real-session");
  });

  it("promotes only the draft named by its own new-session response", () => {
    const sessions = useSessionsStore();
    const pending = usePromptPendingStore();
    const ui = useUiStore();
    const owned = sessions.createPending("/same/cwd", "codex");
    const unrelated = sessions.createPending("/same/cwd", "codex");
    const promptId = pending.add(owned, {
      text: "owned prompt",
      imageCount: 0,
      startedAtLineCount: 0,
      agent: "codex",
      phase: "accepted",
    });
    ui.select(owned);

    expect(promotePendingDraft(owned, "real-owned-session")).toBe(true);
    expect(sessions.isPending(owned)).toBe(false);
    expect(sessions.isPending(unrelated)).toBe(true);
    expect(sessions.resolvePromoted(owned)).toBe("real-owned-session");
    expect(pending.pending("real-owned-session").map((entry) => entry.id)).toEqual([promptId]);
    expect(pending.pending(unrelated)).toEqual([]);
    expect(ui.selectedSessionId).toBe("real-owned-session");
  });

  it("ignores corrupt storage and non-draft keys", () => {
    localStorage.setItem(KEY, JSON.stringify({
      "draft:1-1": { cwd: "/ok", createdAt: 1 },
      "not-a-draft": { cwd: "/bad", createdAt: 2 },
      "draft:2-2": { createdAt: 3 }, // missing cwd
    }));
    setActivePinia(createPinia());
    const s = useSessionsStore();
    expect(s.isPending("draft:1-1")).toBe(true);
    expect(s.isPending("not-a-draft")).toBe(false);
    expect(s.isPending("draft:2-2")).toBe(false);
  });
});
