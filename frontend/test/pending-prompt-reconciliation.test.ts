import { describe, expect, it } from "vitest";
import {
  matchedCodexPendingPromptIds,
  normalizePendingUserText,
  pendingPromptProbeRange,
} from "../src/util/pending-prompt-reconciliation.js";

function userLanding(message: string, clientId?: string): string {
  return JSON.stringify({
    timestamp: "2026-07-26T09:48:26.072Z",
    type: "event_msg",
    payload: {
      type: "user_message",
      ...(clientId ? { client_id: clientId } : {}),
      message,
      images: [],
    },
  });
}

describe("Codex optimistic prompt reconciliation", () => {
  it("uses client_id even when the source cursor raced past the landing line", () => {
    const id = "1785059303649-by4baxxkxko";
    const raw = [
      userLanding("允许啊", id),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "好" } }),
    ];

    expect(matchedCodexPendingPromptIds(raw, [{
      id,
      text: "允许啊",
      // Reproduces the observed race: the only user record is at index 0,
      // while the liveness cursor already reported the next physical line.
      startedAtLineCount: 1,
    }])).toEqual([id]);
  });

  it("does not let an older identical message clear a new legacy entry", () => {
    expect(matchedCodexPendingPromptIds(
      [userLanding("继续")],
      [{ id: "new-entry", text: "继续", startedAtLineCount: 1 }],
    )).toEqual([]);
  });

  it("keeps text and source-boundary matching for records without client_id", () => {
    expect(matchedCodexPendingPromptIds(
      [JSON.stringify({ type: "event_msg", payload: { type: "turn_started" } }), userLanding("继续")],
      [{ id: "legacy-entry", text: "继续", startedAtLineCount: 1 }],
    )).toEqual(["legacy-entry"]);
  });

  it("normalizes attachment trailers before legacy text matching", () => {
    expect(normalizePendingUserText(
      "看一下\n\nAttached files (read with the Read tool to view):\n- a.png",
    )).toBe("看一下");
  });

  it("probes only a small range when the send boundary is outside the cold tail", () => {
    const entry = {
      id: "1785058653740-mt9xcjwuajk",
      text: "现在这个 slash command 好多没接进来",
      startedAtLineCount: 509,
    };

    expect(pendingPromptProbeRange(entry, 527)).toEqual({ from: 505, to: 527 });
    expect(pendingPromptProbeRange(entry, 500)).toBeNull();
  });

  it("drops an accepted non-steered prompt that was migrated into the wrong session", () => {
    expect(matchedCodexPendingPromptIds(
      [userLanding("这个 status 似乎不对", "real-session-client")],
      [{
        id: "audit-draft-client",
        text: "你仔细审计一下现在这个项目还有没有什么问题，有什么bug",
        startedAtLineCount: 0,
        phase: "accepted",
      }],
    )).toEqual(["audit-draft-client"]);
  });

  it("preserves a steered prompt even when later user turns exist", () => {
    expect(matchedCodexPendingPromptIds(
      [userLanding("later turn", "later-client")],
      [{
        id: "steered-client",
        text: "injected into the active turn",
        startedAtLineCount: 0,
        phase: "accepted",
        steered: true,
      }],
    )).toEqual([]);
  });
});
