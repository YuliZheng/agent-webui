import { describe, expect, it } from "vitest";
import { isGlobalPushEvent } from "../src/events.js";

describe("push event envelope", () => {
  it("requires matching type/kind for global pushes", () => {
    expect(
      isGlobalPushEvent({
        type: "session-touched",
        kind: "session-touched",
        id: "abc",
      }),
    ).toBe(true);
    expect(
      isGlobalPushEvent({
        type: "session-touched",
        kind: "session-added",
        id: "abc",
      }),
    ).toBe(false);
    expect(isGlobalPushEvent({ type: "stream-line", kind: "stream-line" })).toBe(
      false,
    );
  });

  it("recognizes capacity retry pushes as global events", () => {
    expect(
      isGlobalPushEvent({
        type: "capacity-retry",
        kind: "capacity-retry",
        sessionId: "session",
        turnId: "turn",
        attempt: 2,
        maxAttempts: 6,
        delayMs: 500,
        retryAt: "2026-07-30T10:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isGlobalPushEvent({
        type: "capacity-retry",
        kind: "session-status",
        sessionId: "session",
      }),
    ).toBe(false);
  });
});
