import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@claude-webui/shared/api";
import {
  effectiveSessionActivityIso,
  effectiveSessionActivityMs,
} from "../src/util/session-recency.js";

function session(
  lastTurnAt: string | null,
  mtime = "2026-07-27T10:00:00.000Z",
): SessionListItem {
  return {
    id: "session",
    cwd: "C:\\work",
    mtime,
    size: 1,
    title: null,
    parentSessionId: null,
    lastTurnAt,
  };
}

describe("session sidebar recency", () => {
  it("prefers last-turn time over sidechain file mtime", () => {
    const item = session(
      "2026-07-27T09:00:00.000Z",
      "2026-07-27T10:00:00.000Z",
    );
    expect(effectiveSessionActivityIso(item)).toBe(
      "2026-07-27T09:00:00.000Z",
    );
  });

  it("uses the newest draft or optimistic prompt immediately", () => {
    const item = session("2026-07-27T09:00:00.000Z");
    const draft = Date.parse("2026-07-27T11:00:00.000Z");
    const sent = Date.parse("2026-07-27T11:01:00.000Z");

    expect(effectiveSessionActivityMs(item, draft, sent)).toBe(sent);
    expect(effectiveSessionActivityIso(item, draft, sent)).toBe(
      "2026-07-27T11:01:00.000Z",
    );
  });
});
