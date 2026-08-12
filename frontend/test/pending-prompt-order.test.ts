import { describe, expect, it } from "vitest";
import type { PendingPrompt } from "../src/stores/prompt-pending.js";
import { interleavePendingPrompts } from "../src/util/pending-prompt-order.js";

type Entry = { id: string; sourceLineIndex: number | null };

function pending(
  id: string,
  startedAtLineCount: number,
  overrides: Partial<PendingPrompt> = {},
): PendingPrompt {
  return {
    id,
    text: id,
    imageCount: 0,
    startedAt: startedAtLineCount,
    startedAtLineCount,
    agent: "codex",
    steered: true,
    phase: "accepted",
    ...overrides,
  };
}

function labels(entries: Entry[], prompts: PendingPrompt[]): string[] {
  return interleavePendingPrompts(entries, prompts, entry => entry.sourceLineIndex)
    .map(item => item.kind === "entry" ? `entry:${item.entry.id}` : `pending:${item.prompt.id}`);
}

describe("pending prompt transcript order", () => {
  it("keeps a Codex steer at its send boundary as later records stream in", () => {
    const prompts = [pending("steer", 12)];
    expect(labels([
      { id: "before", sourceLineIndex: 10 },
      { id: "first-after", sourceLineIndex: 12 },
      { id: "later-tool", sourceLineIndex: 13 },
      { id: "later-reply", sourceLineIndex: 18 },
    ], prompts)).toEqual([
      "entry:before",
      "pending:steer",
      "entry:first-after",
      "entry:later-tool",
      "entry:later-reply",
    ]);
  });

  it("orders multiple steers stably and leaves ordinary queued sends at the tail", () => {
    const prompts = [
      pending("second-at-12", 12, { startedAt: 2 }),
      pending("first-at-12", 12, { startedAt: 1 }),
      pending("queue", 9, { agent: "claude", steered: false }),
    ];
    expect(labels([
      { id: "before", sourceLineIndex: 11 },
      { id: "after", sourceLineIndex: 14 },
    ], prompts)).toEqual([
      "entry:before",
      "pending:first-at-12",
      "pending:second-at-12",
      "entry:after",
      "pending:queue",
    ]);
  });

  it("keeps an unacknowledged steer visible at the live tail until a later record arrives", () => {
    expect(labels(
      [{ id: "current-tail", sourceLineIndex: 20 }],
      [pending("steer", 21, { phase: "sending" })],
    )).toEqual(["entry:current-tail", "pending:steer"]);
  });

  it("anchors a Codex send even when stale UI status failed to mark it as steered", () => {
    expect(labels([
      { id: "before", sourceLineIndex: 30 },
      { id: "reply", sourceLineIndex: 34 },
    ], [pending("status-race", 31, { steered: false })])).toEqual([
      "entry:before",
      "pending:status-race",
      "entry:reply",
    ]);
  });
});
