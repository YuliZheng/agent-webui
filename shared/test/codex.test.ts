import { describe, expect, it } from "vitest";
import {
  codexPayloadRole,
  codexPayloadType,
  codexSessionCwd,
  codexSessionId,
  isCodexEventMessageLine,
  isCodexResponseItemLine,
  isCodexRolloutLine,
  isCodexSessionMetaLine,
  isCodexSessionMetaPayload,
  isCodexTurnContextLine,
} from "../src/codex/index.js";

describe("Codex rollout guards", () => {
  const metadata = {
    timestamp: "2026-07-23T00:00:00Z",
    type: "session_meta",
    payload: { id: "thread_1", cwd: "C:\\repo", future: true },
  };

  it("accepts known and unknown rollout record types", () => {
    expect(isCodexRolloutLine(metadata)).toBe(true);
    expect(
      isCodexRolloutLine({
        timestamp: "now",
        type: "future_record",
        payload: null,
      }),
    ).toBe(true);
    expect(isCodexRolloutLine({ timestamp: "now", type: "event_msg" })).toBe(
      false,
    );
    expect(isCodexRolloutLine(null)).toBe(false);
  });

  it("extracts metadata without assuming generated protocol shapes", () => {
    expect(isCodexSessionMetaLine(metadata)).toBe(true);
    expect(isCodexSessionMetaPayload(metadata.payload)).toBe(true);
    expect(codexSessionId(metadata)).toBe("thread_1");
    expect(codexSessionCwd(metadata)).toBe("C:\\repo");
    expect(
      codexSessionId({
        ...metadata,
        payload: { session_id: "older-id", cwd: "/repo" },
      }),
    ).toBe("older-id");
  });

  it("narrows render-relevant records and nested payload fields", () => {
    const response = {
      timestamp: "now",
      type: "response_item",
      payload: { type: "message", role: "assistant" },
    };
    const event = {
      timestamp: "now",
      type: "event_msg",
      payload: { type: "user_message", message: "hello" },
    };
    const context = {
      timestamp: "now",
      type: "turn_context",
      payload: {},
    };
    expect(isCodexResponseItemLine(response)).toBe(true);
    expect(isCodexEventMessageLine(event)).toBe(true);
    expect(isCodexTurnContextLine(context)).toBe(true);
    expect(codexPayloadType(response)).toBe("message");
    expect(codexPayloadRole(response)).toBe("assistant");
    expect(codexPayloadRole(event)).toBeUndefined();
  });
});
