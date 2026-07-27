import { describe, expect, it } from "vitest";
import {
  hasLoadedCodexUsageBoundary,
  mergeIndexedUsageLines,
  needsCodexUsageBackfill,
  USAGE_BACKFILL_MAX_LINES,
} from "../src/util/context-usage-history.js";

const usage = JSON.stringify({
  type: "event_msg",
  payload: { type: "token_count", info: { last_token_usage: { total_tokens: 10_000 } } },
});
const compacted = JSON.stringify({ type: "compacted", payload: { message: "summary" } });
const message = JSON.stringify({
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
});

describe("Codex usage history backfill", () => {
  it("requests older records only when a tail starts after index zero without a compaction boundary", () => {
    expect(needsCodexUsageBackfill(500, [message, usage])).toBe(true);
    expect(needsCodexUsageBackfill(0, [message, usage])).toBe(false);
    expect(needsCodexUsageBackfill(500, [compacted, message, usage])).toBe(false);
    expect(USAGE_BACKFILL_MAX_LINES).toBe(2_000);
  });

  it("recognizes event-style context compaction before the latest usage report", () => {
    const eventBoundary = JSON.stringify({
      type: "event_msg",
      payload: { type: "context_compacted" },
    });
    expect(hasLoadedCodexUsageBoundary([eventBoundary, message, usage])).toBe(true);
  });

  it("merges a bounded older range with sparse live rows and lets live rows win", () => {
    const merged = mergeIndexedUsageLines(
      [
        { index: 3, raw: "older-3" },
        { index: 4, raw: "stale-4" },
      ],
      ["", "", "", "", "live-4", "live-5"],
    );
    expect(merged).toEqual(["older-3", "live-4", "live-5"]);
  });
});
