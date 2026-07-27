import { describe, expect, it } from "vitest";
import {
  isAgentKind,
  isCodexGoalInput,
  isIndexedRawLine,
  isJsonValue,
  isRpcMethod,
  isRpcRequestEnvelope,
  isRpcResponse,
  isSessionId,
  isSessionListItem,
  isStreamWireLine,
  type PromptImageInput,
  type RpcResponsePayloads,
} from "../src/api.js";

describe("shared API runtime guards", () => {
  it("enforces the session-id whitelist", () => {
    expect(isSessionId("abc_DEF-123")).toBe(true);
    expect(isSessionId("../escape")).toBe(false);
    expect(isSessionId("a/b")).toBe(false);
    expect(isSessionId(1)).toBe(false);
  });

  it("validates required session list fields defensively", () => {
    const valid = {
      id: "session_1",
      cwd: "C:\\repo",
      mtime: "2026-07-23T00:00:00.000Z",
      size: 123,
      agent: "codex",
      subagent: true,
      title: null,
      status: "running",
    };
    expect(isSessionListItem(valid)).toBe(true);
    expect(isSessionListItem({ ...valid, id: "../x" })).toBe(false);
    expect(isSessionListItem({ ...valid, size: Number.NaN })).toBe(false);
    expect(isSessionListItem({ ...valid, agent: "other-agent" })).toBe(false);
    expect(isSessionListItem({ ...valid, subagent: "yes" })).toBe(false);
    expect(isAgentKind("claude")).toBe(true);
    expect(isAgentKind("other-agent")).toBe(false);
  });

  it("keeps indexed cache and stream wire line shapes distinct", () => {
    expect(isIndexedRawLine({ index: 0, raw: "{}" })).toBe(true);
    expect(isIndexedRawLine({ index: 0, data: "{}" })).toBe(false);
    expect(isStreamWireLine({ index: 3, data: "{}" })).toBe(true);
    expect(isStreamWireLine({ index: -1, data: "{}" })).toBe(false);
  });

  it("recognizes the common RPC envelopes and all declared methods", () => {
    expect(isRpcRequestEnvelope({ type: "get-sessions", reqId: "r1" })).toBe(
      true,
    );
    expect(isRpcRequestEnvelope({ type: "get-sessions" })).toBe(false);
    expect(isRpcMethod("fork")).toBe(true);
    expect(isRpcMethod("unknown-method")).toBe(false);
    expect(isRpcResponse({ type: "result", reqId: "r1", ok: true, data: {} })).toBe(
      true,
    );
    expect(
      isRpcResponse({ type: "error", reqId: "r1", code: 409, message: "conflict" }),
    ).toBe(true);
  });

  it("accepts JSON values but rejects non-JSON and non-finite data", () => {
    expect(isJsonValue({ answer: ["one", true, null, 2] })).toBe(true);
    expect(isJsonValue({ value: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
  });

  it("validates top-level Codex goal fields", () => {
    expect(isCodexGoalInput({ objective: "ship", status: "active", tokenBudget: 5000 })).toBe(true);
    expect(isCodexGoalInput({ goal: "nested" })).toBe(false);
    expect(isCodexGoalInput({ objective: "ship", status: "unknown" })).toBe(false);
    expect(isCodexGoalInput({ objective: "ship", tokenBudget: 0 })).toBe(false);
  });

  it("keeps attachment and mutation response contracts aligned with the wire", () => {
    const attachment: PromptImageInput = {
      name: "diagram.png",
      type: "image/png",
      data: "data:image/png;base64,aA==",
    };
    const kill: RpcResponsePayloads["kill"] = {};
    const compact: RpcResponsePayloads["compact-session"] = {};
    const model: RpcResponsePayloads["set-model"] = { applies: "next-process" };
    const permission: RpcResponsePayloads["set-permission-mode"] = { applies: "immediately" };
    const interaction: RpcResponsePayloads["interaction-respond"] = {};
    const clearedTitle: RpcResponsePayloads["set-title"] = { title: null };
    const prompt: RpcResponsePayloads["prompt"] = { sessionId: "s1", steered: true };

    expect(attachment).toMatchObject({ type: "image/png", data: expect.stringContaining("base64") });
    expect(kill).toEqual({});
    expect(compact).toEqual({});
    expect(model.applies).toBe("next-process");
    expect(permission.applies).toBe("immediately");
    expect(interaction).toEqual({});
    expect(clearedTitle.title).toBeNull();
    expect(prompt).toEqual({ sessionId: "s1", steered: true });
  });
});
