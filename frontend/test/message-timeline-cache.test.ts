import { describe, expect, it } from "vitest";
import { messageTimeline, primeMessageTimeline } from "../src/util/message-timeline-cache.js";

function userLine(uuid: string, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    message: { role: "user", content: text },
  });
}

describe("message timeline cache", () => {
  it("reuses a parsed timeline while the transcript content is unchanged", () => {
    const lines = [userLine("u-1", "hello")];
    const input = {
      sessionId: "timeline-reuse",
      contentRevision: 1,
      lines,
      isCodex: false,
      suppressLatestEmptyCompletion: false,
    };

    const first = messageTimeline(input);
    const second = messageTimeline(input);
    expect(second).toBe(first);

    lines.push(userLine("u-2", "again"));
    const changed = messageTimeline({ ...input, contentRevision: 2 });
    expect(changed).not.toBe(first);
    expect(changed).toHaveLength(2);
  });

  it("can prime an ordinary neighboring conversation without changing output", () => {
    const input = {
      sessionId: "timeline-prime",
      contentRevision: 1,
      lines: [userLine("u-prime", "ready")],
      isCodex: false,
      suppressLatestEmptyCompletion: false,
    };

    expect(primeMessageTimeline(input)).toBe(true);
    const timeline = messageTimeline(input);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.record.uuid).toBe("u-prime");
  });
});
