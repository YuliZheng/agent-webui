import { describe, expect, it } from "vitest";
import {
  assertDirectPromptAllowed,
  normalizeDirectPromptError,
  SUBAGENT_READONLY_MESSAGE,
} from "../src/services/session-prompt.js";

describe("session prompt access", () => {
  it("rejects a Codex sub-agent worker with a useful conflict", () => {
    expect(() => assertDirectPromptAllowed({
      agent: "codex",
      subagent: true,
      parentSessionId: "parent-thread",
    })).toThrowError(SUBAGENT_READONLY_MESSAGE);

    try {
      assertDirectPromptAllowed({ agent: "codex", subagent: true, parentSessionId: "parent-thread" });
    } catch (error) {
      expect(error).toMatchObject({ code: 409 });
    }
  });

  it("keeps an ordinary fork writable even when it has a parent", () => {
    expect(() => assertDirectPromptAllowed({
      agent: "codex",
      parentSessionId: "parent-thread",
    })).not.toThrow();
  });

  it("maps the app-server v2 worker error without hiding unrelated failures", () => {
    const mapped = normalizeDirectPromptError(new Error(
      "direct app-server input is not allowed for multi-agent v2 sub-agents",
    ));
    expect(mapped).toMatchObject({ code: 409, message: SUBAGENT_READONLY_MESSAGE });

    const unrelated = new Error("turn/start failed");
    expect(normalizeDirectPromptError(unrelated)).toBe(unrelated);
  });
});
