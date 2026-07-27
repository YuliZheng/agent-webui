import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getCodexRateLimits: vi.fn(),
}));

vi.mock("../src/api/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/sessions.js")>()),
  getCodexRateLimits: apiMocks.getCodexRateLimits,
}));

import {
  buildSessionStatusSummary,
  latestCodexContextUsage,
  localCommandEntries,
  parseLocalCommand,
  runLocalCommand,
} from "../src/util/local-commands.js";
import { useLocalBubblesStore } from "../src/stores/local-bubbles.js";
import { usePrefsStore } from "../src/stores/prefs.js";
import { useSessionSettingsStore } from "../src/stores/session-settings.js";
import { useSessionsStore } from "../src/stores/sessions.js";

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type, payload });
}

function message(role: "user" | "assistant" | "developer" | "system", text = ""): string {
  return line("response_item", {
    type: "message",
    role,
    content: text ? [{ type: role === "assistant" ? "output_text" : "input_text", text }] : [],
  });
}

function imageMessage(text: string, encodedSize: number): string {
  return line("response_item", {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text },
      { type: "input_image", image_url: `data:image/jpeg;base64,${"x".repeat(encodedSize)}` },
    ],
  });
}

function reasoning(size: number): string {
  return line("response_item", { type: "reasoning", encrypted_content: "x".repeat(size) });
}

function toolCall(callId: string, name: string): string {
  return line("response_item", { type: "function_call", call_id: callId, name, arguments: "{}" });
}

function toolOutput(callId: string, size: number): string {
  return line("response_item", { type: "function_call_output", call_id: callId, output: "x".repeat(size) });
}

function orchestratedToolCall(callId: string, input: string): string {
  return line("response_item", { type: "custom_tool_call", call_id: callId, name: "exec", input });
}

function orchestratedToolOutput(callId: string, size: number): string {
  return line("response_item", { type: "custom_tool_call_output", call_id: callId, output: "x".repeat(size) });
}

function imageGeneration(resultSize: number): string {
  return line("response_item", {
    type: "image_generation_call",
    status: "completed",
    result: "x".repeat(resultSize),
  });
}

function tokenCount(total: number, input = total, output = 0, window = 258_400): string {
  return line("event_msg", {
    type: "token_count",
    info: {
      last_token_usage: {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
      },
      model_context_window: window,
    },
  });
}

describe("local slash commands", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    apiMocks.getCodexRateLimits.mockReset();
    apiMocks.getCodexRateLimits.mockResolvedValue({
      planType: "plus",
      primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 12.5, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
    });
  });

  it("keeps goal as codex-only local command", () => {
    expect(localCommandEntries(false).map((c) => c.name)).not.toContain("goal");
    expect(localCommandEntries(true).map((c) => c.name)).toContain("goal");
    expect(parseLocalCommand("/goal ship slash commands", false)).toBeNull();
    expect(parseLocalCommand("/goal ship slash commands", true)).toEqual({
      name: "goal",
      arg: "ship slash commands",
    });
  });

  it("keeps compact local for codex and provider-forwarded for claude", () => {
    expect(parseLocalCommand("/compact", false)).toBeNull();
    expect(parseLocalCommand("/compact", true)).toEqual({ name: "compact", arg: "" });
  });

  it("offers functional status and CLI-info commands to both agents", () => {
    for (const isCodex of [false, true]) {
      const names = localCommandEntries(isCodex).map((command) => command.name);
      expect(names).toEqual(expect.arrayContaining(["status", "mcp", "version", "doctor"]));
      expect(parseLocalCommand("/status", isCodex)).toEqual({ name: "status", arg: "" });
    }
    expect(localCommandEntries(true).map((command) => command.name))
      .toEqual(expect.arrayContaining(["effort", "fast", "permissions"]));
  });

  it("renders Codex status from the same effective settings as the pills, with account limits", async () => {
    const sessions = useSessionsStore();
    sessions.byId.s1 = {
      id: "s1",
      cwd: "C:\\work",
      mtime: "",
      size: 0,
      title: null,
      parentSessionId: null,
      agent: "codex",
    };
    sessions.statusBySession.s1 = "running";
    const prefs = usePrefsStore();
    prefs.defaultModel = "deepseek-v4-pro";
    prefs.defaultCodexModel = "gpt-5.6-sol";
    prefs.defaultCodexEffort = "medium";
    prefs.defaultCodexApproval = "full-access";
    useSessionSettingsStore().apply({
      id: "s1",
      serviceTier: "priority",
    });

    await runLocalCommand(
      { name: "status", arg: "" },
      {
        sessionId: "s1",
        isCodex: true,
        model: "gpt-5.6-sol",
        ctxTokens: 100_000,
        ctxLimit: 200_000,
        lines: [],
      },
    );

    const bubble = useLocalBubblesStore().bySession.s1;
    expect(bubble?.title).toBe("Status");
    expect(bubble?.markdown).toContain("`running`");
    expect(bubble?.markdown).toContain("`gpt-5.6-sol`");
    expect(bubble?.markdown).not.toContain("deepseek-v4-pro");
    expect(bubble?.markdown).toContain("`medium`");
    expect(bubble?.markdown).toContain("`on`");
    expect(bubble?.markdown).toContain("`full-access`");
    expect(bubble?.markdown).toContain("`100.0k / 200.0k (50%)`");
    expect(bubble?.markdown).toContain("**5-hour usage:**");
    expect(bubble?.markdown).toContain("`40% used · 60% left");
    expect(bubble?.markdown).toContain("**Weekly usage:**");
    expect(bubble?.markdown).toContain("`12.5% used · 87.5% left");
    expect(apiMocks.getCodexRateLimits).toHaveBeenCalledWith("s1");
  });

  it("deduplicates identical primary and weekly account windows", async () => {
    const sessions = useSessionsStore();
    sessions.byId.s1 = {
      id: "s1",
      cwd: "C:\\work",
      mtime: "",
      size: 0,
      title: null,
      parentSessionId: null,
      agent: "codex",
    };
    apiMocks.getCodexRateLimits.mockResolvedValue({
      planType: "pro",
      primary: { usedPercent: 15, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
      secondary: { usedPercent: 15, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
    });

    const summary = await buildSessionStatusSummary({
      sessionId: "s1",
      isCodex: true,
      model: "gpt-5.6-sol",
      ctxTokens: 100_000,
      ctxLimit: 200_000,
      lines: [],
    });

    expect(summary.rows.filter((row) => row.label.endsWith("usage"))).toEqual([
      expect.objectContaining({ label: "Weekly usage" }),
    ]);
  });
});

describe("Codex context usage", () => {
  it("uses Codex's reported context total without adding a second local estimate", () => {
    const usage = latestCodexContextUsage([
      line("session_meta", { model_provider: "openai_http" }),
      message("user"),
      reasoning(2_000),
      message("user"),
      reasoning(2_000),
      tokenCount(230_100, 230_000, 100),
    ]);

    expect(usage).toEqual({
      tokens: 230_100,
      limit: 244_800,
      reportedTokens: 230_100,
      contributors: expect.any(Array),
    });
    expect(usage.contributors?.reduce((sum, item) => sum + item.tokens, 0)).toBe(230_100);
    expect(usage.contributors?.reduce((sum, item) => sum + item.percent, 0)).toBe(100);
  });

  it("does not depend on session_meta being present in a tail-only cache", () => {
    const usage = latestCodexContextUsage([
      message("user"),
      reasoning(2_000),
      message("user"),
      reasoning(2_000),
      tokenCount(230_100, 230_000, 100),
    ]);

    expect(usage.tokens).toBe(230_100);
    expect(usage.reportedTokens).toBe(230_100);
    expect(usage.estimatedTokens).toBeUndefined();
    expect(usage.limit).toBe(244_800);
    expect(usage.contributors?.reduce((sum, item) => sum + item.tokens, 0)).toBe(230_100);
  });

  it("forgets pre-compaction reasoning and honors a lower configured limit", () => {
    const usage = latestCodexContextUsage([
      line("session_meta", { model_provider: "openai_http" }),
      message("user"),
      reasoning(4_000),
      JSON.stringify({ type: "compacted", payload: { message: "summary" } }),
      message("user"),
      reasoning(2_000),
      tokenCount(50_000),
    ], 42_000);

    expect(usage.tokens).toBe(50_000);
    expect(usage.estimatedTokens).toBeUndefined();
    expect(usage.limit).toBe(42_000);
  });

  it("reads camelCase app-server usage totals", () => {
    const usage = latestCodexContextUsage([
      line("session_meta", { modelProvider: "openai" }),
      JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          tokenUsage: {
            last: { inputTokens: 1_900, outputTokens: 100, totalTokens: 2_000 },
            modelContextWindow: 258_400,
          },
        },
      }),
    ]);

    expect(usage).toMatchObject({ tokens: 2_000, reportedTokens: 2_000, limit: 244_800 });
  });

  it("estimates source proportions and resets them after compaction", () => {
    const usage = latestCodexContextUsage([
      toolCall("old", "shell_command"),
      toolOutput("old", 20_000),
      JSON.stringify({ type: "compacted", payload: { message: "summary" } }),
      message("user"),
      toolCall("browser", "node_repl.js"),
      toolOutput("browser", 8_000),
      toolCall("shell", "shell_command"),
      toolOutput("shell", 2_000),
      tokenCount(10_000),
    ]);

    expect(usage.contributors?.[0]?.source).toBe("other");
    expect(usage.contributors?.find((item) => item.source === "browser")?.tokens).toBeGreaterThan(0);
    expect(usage.contributors?.some((item) => item.source === "shell")).toBe(true);
    expect(usage.contributors?.find((item) => item.source === "shell")?.tokens).toBeLessThan(1_000);
    expect(usage.contributors?.reduce((sum, item) => sum + item.tokens, 0)).toBe(10_000);
    expect(usage.contributors?.reduce((sum, item) => sum + item.percent, 0)).toBe(100);
  });

  it("separates user, assistant, AGENTS.md, skills, and other injected context", () => {
    const usage = latestCodexContextUsage([
      message("user", "Please inspect the project and fix the bug."),
      message("assistant", "I found the issue and updated the component."),
      message(
        "user",
        "# AGENTS.md instructions for C:\\work\n\n<INSTRUCTIONS>\nDo not restart services.\n</INSTRUCTIONS>",
      ),
      message(
        "developer",
        [
          "<permissions instructions>Filesystem access is unrestricted.</permissions instructions>",
          "<skills_instructions>",
          "## Skills",
          "- browser: Control the browser when local UI verification is needed.",
          "</skills_instructions>",
          "<environment_context>cwd C:\\work</environment_context>",
        ].join("\n"),
      ),
      tokenCount(12_000),
    ]);

    const sources = new Set(usage.contributors?.map((item) => item.source));
    expect([...sources]).toEqual(expect.arrayContaining([
      "user",
      "assistant",
      "agents",
      "skills",
      "instructions",
    ]));
    expect(usage.contributors?.find((item) => item.source === "agents")?.tokens).toBeGreaterThan(0);
    expect(usage.contributors?.find((item) => item.source === "skills")?.tokens).toBeGreaterThan(0);
    expect(usage.contributors?.reduce((sum, item) => sum + item.tokens, 0)).toBe(12_000);
    expect(usage.contributors?.reduce((sum, item) => sum + item.percent, 0)).toBe(100);
    expect(usage.contributors?.find((item) => item.source === "user")?.percent).toBeLessThan(2);
  });

  it("does not mistake embedded image bytes for user-message tokens", () => {
    const usage = latestCodexContextUsage([
      imageMessage("Please inspect this screenshot.", 300_000),
      tokenCount(12_000),
    ]);

    const user = usage.contributors?.find((item) => item.source === "user");
    const images = usage.contributors?.find((item) => item.source === "images");
    expect(user?.tokens).toBeLessThan(100);
    expect(images?.tokens).toBe(1_844);
    expect((user?.tokens ?? 0) + (images?.tokens ?? 0)).toBeLessThan(2_000);
    expect(usage.tokens).toBe(12_000);
    expect(usage.contributors?.reduce((sum, item) => sum + item.tokens, 0)).toBe(12_000);
    expect(usage.contributors?.reduce((sum, item) => sum + item.percent, 0)).toBe(100);
  });

  it("keeps large pending tool output out of the authoritative total", () => {
    const usage = latestCodexContextUsage([
      orchestratedToolCall("exec-shell", "await tools.shell_command({ command: 'large build' })"),
      orchestratedToolOutput("exec-shell", 100_000),
      tokenCount(12_000),
    ]);

    const shell = usage.contributors?.find((item) => item.source === "shell");
    expect(shell?.tokens).toBeGreaterThanOrEqual(2_000);
    expect(shell?.tokens).toBeLessThan(2_100);
    expect(usage.contributors?.some((item) => item.source === "tools")).toBe(false);
    expect(usage.tokens).toBe(12_000);
    expect(usage.contributors?.reduce((sum, item) => sum + item.tokens, 0)).toBe(12_000);
  });

  it("classifies generated images as images without treating result base64 as text", () => {
    const usage = latestCodexContextUsage([
      imageGeneration(300_000),
      tokenCount(8_000),
    ]);

    const images = usage.contributors?.find((item) => item.source === "images");
    expect(images?.tokens).toBe(1_844);
    expect(usage.tokens).toBe(8_000);
    expect(usage.contributors?.reduce((sum, item) => sum + item.tokens, 0)).toBe(8_000);
    expect(usage.contributors?.reduce((sum, item) => sum + item.percent, 0)).toBe(100);
  });
});
