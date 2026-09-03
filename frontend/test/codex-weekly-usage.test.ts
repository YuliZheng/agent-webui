import { describe, expect, it } from "vitest";
import {
  accountTokensInRateLimitWindow,
  estimateConversationWeeklyUsage,
} from "../src/util/codex-weekly-usage.js";

describe("Codex weekly usage estimate", () => {
  it("uses the rate-limit window and daily account buckets to infer an equivalent capacity", () => {
    const dailyUsageBuckets = Array.from({ length: 7 }, (_, index) => ({
      startDate: `2026-08-${String(22 + index).padStart(2, "0")}`,
      tokens: 1_000_000,
    }));
    const weeklyWindow = {
      usedPercent: 25,
      windowDurationMins: 7 * 24 * 60,
      resetsAt: Date.UTC(2026, 7, 29) / 1_000,
    };

    expect(accountTokensInRateLimitWindow(dailyUsageBuckets, weeklyWindow)).toBe(7_000_000);
    expect(estimateConversationWeeklyUsage({
      cumulativeTokens: 2_800_000,
      weeklyUsagePercent: 25,
      weeklyWindow,
      dailyUsageBuckets,
    })).toEqual({
      accountTokensInWindow: 7_000_000,
      estimatedWeeklyTokenCapacity: 28_000_000,
      conversationPercent: 10,
    });
  });

  it("prorates daily buckets when the rolling week starts and ends mid-day", () => {
    const weeklyWindow = {
      usedPercent: 50,
      windowDurationMins: 24 * 60,
      resetsAt: Date.UTC(2026, 7, 29, 12) / 1_000,
    };
    const dailyUsageBuckets = [
      { startDate: "2026-08-28", tokens: 1_000 },
      { startDate: "2026-08-29", tokens: 3_000 },
    ];

    expect(accountTokensInRateLimitWindow(dailyUsageBuckets, weeklyWindow)).toBe(2_000);
  });

  it("returns no estimate when account progress or bucket coverage is unavailable", () => {
    expect(estimateConversationWeeklyUsage({
      cumulativeTokens: 1_000_000,
      weeklyUsagePercent: 0,
      weeklyWindow: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
      dailyUsageBuckets: [],
    })).toBeNull();
  });
});
