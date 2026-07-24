import { describe, expect, it } from "vitest";
import {
  assistantContentBlocks,
  hasIsApiErrorMessage,
  hasIsCompactSummary,
  hasIsMeta,
  isAssistant,
  isClaudeThinkingBlock,
  isClaudeToolResultBlock,
  isClaudeToolUseBlock,
  isQueueOperation,
  isQueuedCommandAttachment,
  isSidechain,
  isSystem,
  isUser,
  isUserPromptShape,
  isUserToolResultShape,
  structuredToolUseResult,
  systemSubtype,
  topLevelType,
  userToolResultBlocks,
} from "../src/claude.js";

describe("Claude record discriminators", () => {
  it("narrows only from a string top-level type", () => {
    expect(topLevelType({ type: "user" })).toBe("user");
    expect(topLevelType({ type: 12 })).toBeUndefined();
    expect(topLevelType(null)).toBeUndefined();
    expect(isUser({ type: "user" })).toBe(true);
    expect(isAssistant({ type: "assistant" })).toBe(true);
    expect(isSystem({ type: "system" })).toBe(true);
    expect(isUser({ type: "assistant" })).toBe(false);
  });

  it("separates string/text prompt content from tool results", () => {
    const stringPrompt = {
      type: "user",
      message: { role: "user", content: "hello" },
    };
    const blockPrompt = {
      type: "user",
      message: {
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
    };
    const results = {
      type: "user",
      toolUseResult: { stdout: "structured" },
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "fallback",
          },
        ],
      },
    };

    expect(isUserPromptShape(stringPrompt)).toBe(true);
    expect(isUserPromptShape(blockPrompt)).toBe(true);
    expect(isUserPromptShape(results)).toBe(false);
    expect(isUserToolResultShape(results)).toBe(true);
    expect(userToolResultBlocks(results)).toHaveLength(1);
    expect(structuredToolUseResult(results)).toEqual({ stdout: "structured" });
  });

  it("rejects malformed and mixed user content without throwing", () => {
    const values: unknown[] = [
      undefined,
      [],
      { type: "user" },
      { type: "user", message: { content: [] } },
      {
        type: "user",
        message: {
          content: [
            { type: "text", text: "prompt" },
            { type: "tool_result", tool_use_id: "t" },
          ],
        },
      },
      { type: "user", message: { content: [{ type: "text", text: 1 }] } },
    ];

    for (const value of values) {
      expect(() => isUserPromptShape(value)).not.toThrow();
      expect(() => isUserToolResultShape(value)).not.toThrow();
    }
    expect(isUserPromptShape(values[3])).toBe(false);
    expect(isUserToolResultShape(values[4])).toBe(false);
  });

  it("recognizes assistant block shapes and preserves unknown blocks", () => {
    const assistant = {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "tool_use", id: "t", name: "Read", input: { path: "x" } },
          { type: "future_block", payload: true },
          null,
        ],
      },
    };
    const blocks = assistantContentBlocks(assistant);
    expect(blocks).toHaveLength(3);
    expect(isClaudeThinkingBlock(blocks[0])).toBe(true);
    expect(isClaudeToolUseBlock(blocks[1])).toBe(true);
    expect(isClaudeToolResultBlock(blocks[1])).toBe(false);
    expect(blocks[2]?.type).toBe("future_block");
  });

  it("finds top-level or nested boolean markers", () => {
    expect(hasIsMeta({ isMeta: true })).toBe(true);
    expect(hasIsCompactSummary({ message: { isCompactSummary: true } })).toBe(
      true,
    );
    expect(hasIsApiErrorMessage({ isApiErrorMessage: false })).toBe(false);
    expect(hasIsMeta({ isMeta: "true" })).toBe(false);
  });

  it("identifies sidechains, system subtypes and queue records", () => {
    expect(isSidechain({ type: "assistant", isSidechain: true, agentId: "a" })).toBe(
      true,
    );
    expect(systemSubtype({ type: "system", subtype: "turn_duration" })).toBe(
      "turn_duration",
    );
    expect(systemSubtype({ type: "assistant", subtype: "turn_duration" })).toBeUndefined();
    expect(isQueueOperation({ type: "queue-operation", operation: "enqueue" })).toBe(
      true,
    );
    expect(
      isQueuedCommandAttachment({
        type: "attachment",
        attachment: { type: "queued_command", prompt: "next" },
      }),
    ).toBe(true);
    expect(
      isQueuedCommandAttachment({
        type: "attachment",
        attachment: { type: "image" },
      }),
    ).toBe(false);
  });
});
