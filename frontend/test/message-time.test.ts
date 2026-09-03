import { describe, expect, it } from "vitest";
import {
  MESSAGE_TIME_GAP_MS,
  formatMessageTime,
  parseMessageTimestamp,
  shouldShowMessageTime,
} from "../src/util/message-time.js";

describe("message timeline time labels", () => {
  it("normalizes ISO strings plus Unix seconds and milliseconds", () => {
    const iso = "2026-08-29T10:15:00.000Z";
    expect(parseMessageTimestamp(iso)).toBe(Date.parse(iso));
    expect(parseMessageTimestamp(1_777_630_500)).toBe(1_777_630_500_000);
    expect(parseMessageTimestamp(1_777_630_500_000)).toBe(1_777_630_500_000);
    expect(parseMessageTimestamp("not-a-date")).toBeNull();
  });

  it("shows the first marker, five-minute gaps, and calendar-day boundaries", () => {
    const start = new Date(2026, 7, 29, 12, 0).getTime();
    expect(shouldShowMessageTime(null, start)).toBe(true);
    expect(shouldShowMessageTime(start, start + MESSAGE_TIME_GAP_MS - 1)).toBe(false);
    expect(shouldShowMessageTime(start, start + MESSAGE_TIME_GAP_MS)).toBe(true);
    expect(shouldShowMessageTime(
      new Date(2026, 7, 29, 23, 59).getTime(),
      new Date(2026, 7, 30, 0, 0).getTime(),
    )).toBe(true);
    expect(shouldShowMessageTime(start, start - 1000)).toBe(false);
  });

  it("adds progressively more date context like WeChat", () => {
    const now = new Date(2026, 7, 29, 18, 0).getTime();
    expect(formatMessageTime(new Date(2026, 7, 29, 9, 5).getTime(), now)).toBe("09:05");
    expect(formatMessageTime(new Date(2026, 7, 28, 9, 5).getTime(), now)).toBe("昨天 09:05");
    expect(formatMessageTime(new Date(2026, 7, 27, 9, 5).getTime(), now)).toBe("星期四 09:05");
    expect(formatMessageTime(new Date(2026, 6, 12, 9, 5).getTime(), now)).toBe("7月12日 09:05");
    expect(formatMessageTime(new Date(2025, 11, 3, 9, 5).getTime(), now)).toBe("2025年12月3日 09:05");
  });
});
