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
});
