import { describe, expect, it } from "vitest";
import {
  advanceReadEntry,
  recordUnreadCompletion,
  sessionUnreadCount,
} from "../src/services/read-state.js";

const session = {
  mtime: "2026-08-29T10:00:02.000Z",
  lastTurnAt: "2026-08-29T10:00:02.000Z",
  previewRole: "assistant" as const,
};

describe("global read state", () => {
  it("derives one unread reply when migrating a pre-count read state", () => {
    expect(sessionUnreadCount(session, { at: "2026-08-29T10:00:01.000Z" })).toBe(1);
    expect(sessionUnreadCount(session, { at: session.lastTurnAt })).toBe(0);
  });

  it("counts completions once and never lets a stale read clear newer work", () => {
    const first = recordUnreadCompletion(undefined, "2026-08-29T10:00:02.000Z");
    expect(first).toMatchObject({ unreadAt: "2026-08-29T10:00:02.000Z", unreadCount: 1 });
    expect(recordUnreadCompletion(first, "2026-08-29T10:00:02.000Z")).toEqual(first);

    const second = recordUnreadCompletion(first, "2026-08-29T10:00:03.000Z");
    expect(second.unreadCount).toBe(2);

    const staleRead = advanceReadEntry(second, "2026-08-29T10:00:02.500Z");
    expect(staleRead).toMatchObject({
      at: "2026-08-29T10:00:02.500Z",
      unreadAt: "2026-08-29T10:00:03.000Z",
      unreadCount: 2,
    });

    const currentRead = advanceReadEntry(staleRead, "2026-08-29T10:00:03.000Z");
    expect(currentRead.unreadCount).toBe(0);
    expect(advanceReadEntry(currentRead, "2026-08-29T10:00:01.000Z").at).toBe(currentRead.at);
  });
});
