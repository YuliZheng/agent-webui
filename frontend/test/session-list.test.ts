import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SessionRow from "@/components/SessionRow.vue";
import { isSessionUnread, lockGestureAxis, reconcileSelectedIds, shouldRefreshPull, sortPinnedByActivity } from "@/util/session-list";
import { useSessionsStore } from "@/stores/sessions";
import { mainSocket } from "@/api/ws";
import type { SessionListItem } from "@/types";

const item = (id: string, at: string): SessionListItem => ({ id, cwd: `/tmp/${id}`, mtime: at, lastTurnAt: at, size: 1, agent: "claude" });
function pointer(type: string, x: number, y: number, pointerType = "touch"): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, pointerType: { value: pointerType } }); return event;
}

describe("session list touch contracts", () => {
  it("locks horizontally only when abs(dx) is at least twice abs(dy)", () => {
    expect(lockGestureAxis(10, 5)).toBe("x");
    expect(lockGestureAxis(10, 6)).toBe("y");
    expect(lockGestureAxis(3, 2)).toBeNull();
  });
  it("opens the swipe tray for a strong horizontal swipe, never a vertical gesture", async () => {
    const horizontal = mount(SessionRow, { props: { session: item("a", "2026-01-01T00:00:00Z") } }); const row = horizontal.get(".cw-session-row-wrap").element;
    expect(horizontal.get(".cw-swipe-tray").classes()).not.toContain("active");
    row.dispatchEvent(pointer("pointerdown", 100, 100)); row.dispatchEvent(pointer("pointermove", 20, 70)); row.dispatchEvent(pointer("pointerup", 20, 70));
    expect(horizontal.emitted("tray")?.at(-1)).toEqual(["a"]);
    await horizontal.setProps({ open: true });
    expect(horizontal.get(".cw-swipe-tray").classes()).toContain("active");
    const vertical = mount(SessionRow, { props: { session: item("b", "2026-01-01T00:00:00Z") } }); const other = vertical.get(".cw-session-row-wrap").element;
    other.dispatchEvent(pointer("pointerdown", 100, 100)); other.dispatchEvent(pointer("pointermove", 80, 30)); other.dispatchEvent(pointer("pointerup", 80, 30));
    expect(vertical.emitted("tray")).toBeUndefined();
  });
  it("requires a top-origin, strongly vertical pull over threshold", () => {
    expect(shouldRefreshPull(true, 20, 64)).toBe(true);
    expect(shouldRefreshPull(false, 0, 90)).toBe(false);
    expect(shouldRefreshPull(true, 40, 64)).toBe(false);
    expect(shouldRefreshPull(true, 0, 63)).toBe(false);
  });
});

describe("session list ordering, selection, and unread", () => {
  it("sorts pinned sessions by active state then effective time, ignoring preference order", () => {
    const values = [item("old-active", "2026-01-01T00:00:00Z"), item("new-idle", "2026-04-01T00:00:00Z"), item("new-active", "2026-03-01T00:00:00Z")];
    expect(sortPinnedByActivity(values, (id) => id.endsWith("active"), (value) => Date.parse(value.lastTurnAt!)).map((value) => value.id))
      .toEqual(["new-active", "old-active", "new-idle"]);
  });
  it("keeps failed batch targets selected while removing successfully deleted ids", () => {
    expect(reconcileSelectedIds(["deleted", "failed"], ["failed", "other"])).toEqual(["failed"]);
  });
  it("never marks the current session unread and respects its advanced watermark after handoff", () => {
    const session = item("a", "2026-01-01T00:00:00Z");
    expect(isSessionUnread(session, undefined, "a", Date.parse(session.lastTurnAt!))).toBe(false);
    expect(isSessionUnread(session, "2026-01-02T00:00:00Z", "b", Date.parse(session.lastTurnAt!))).toBe(false);
    expect(isSessionUnread(session, "2025-12-31T00:00:00Z", "b", Date.parse(session.lastTurnAt!))).toBe(true);
  });
  it("advances the previous current-session watermark before switching", () => {
    vi.useFakeTimers(); setActivePinia(createPinia()); vi.spyOn(mainSocket, "request").mockResolvedValue({});
    const store = useSessionsStore(); store.items = [item("a", "2026-01-01T00:00:00Z"), item("b", "2026-01-01T00:00:00Z")]; store.selectedId = "a";
    store.handoffSelection("b");
    expect(store.selectedId).toBe("b"); expect(Date.parse(store.readAt.a!)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z")); expect(store.isUnread(store.items[0]!)).toBe(false);
    vi.runAllTimers(); vi.useRealTimers();
  });
  it("uses one right-side status slot for answering and unread states", () => {
    const answering = mount(SessionRow, { props: { session: item("a", "2026-01-01T00:00:00Z"), answering: true, unreadCount: 120 } });
    expect(answering.get(".cw-session-row").classes()).toContain("is-answering");
    expect(answering.get(".cw-session-state-slot .cw-session-answering-indicator").attributes("aria-label")).toBe("Agent is answering");
    expect(answering.find(".cw-session-unread").exists()).toBe(false);
    const unread = mount(SessionRow, { props: { session: item("b", "2026-01-01T00:00:00Z"), unreadCount: 120 } });
    expect(unread.get(".cw-session-state-slot .cw-session-unread").text()).toBe("99+");
    expect(unread.get(".cw-session-unread").attributes("aria-label")).toBe("120 unread replies");
    expect(unread.find(".cw-session-answering-indicator").exists()).toBe(false);
  });
  it("counts completed replies while away and clears the count when read", async () => {
    localStorage.clear(); setActivePinia(createPinia()); vi.spyOn(mainSocket, "request").mockResolvedValue({});
    const store = useSessionsStore(); store.items = [item("a", "2026-01-01T00:00:00Z")]; store.selectedId = "b";
    store.noteCompletion("a", "2026-01-02T00:00:00Z");
    store.noteCompletion("a", "2026-01-03T00:00:00Z");
    expect(store.unreadCount(store.items[0]!)).toBe(2);
    await store.markRead("a");
    expect(store.unreadCount(store.items[0]!)).toBe(0);
  });
});
