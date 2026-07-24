import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ToolRunBlock from "@/components/blocks/ToolRunBlock.vue";
import type { NormalizedBlock } from "@/types";
import { isBashToolName, toolDisplayName, toolSummary } from "@/util/tool-summary";

describe("tool summaries", () => {
  it("maps Codex shell aliases to concise Bash summaries", () => {
    expect(isBashToolName("shell_command")).toBe(true);
    expect(isBashToolName("functions.exec_command")).toBe(true);
    expect(isBashToolName("local_shell_call")).toBe(true);
    expect(toolDisplayName("shell_command")).toBe("Bash");
    expect(toolSummary("shell_command", { command: "npm\n  test" })).toBe("Bash: npm test");
    expect(toolSummary("exec_command", JSON.stringify({ cmd: "npm run build" }))).toBe("Bash: npm run build");
    expect(toolSummary("local_shell_call", { command: ["git", "status", "--short"] })).toBe("Bash: git status --short");
  });

  it("never exposes a raw shell tool name when command detail is absent", () => {
    expect(toolSummary("shell_command", {})).toBe("Bash");
    expect(toolSummary("codex__exec_command", undefined)).toBe("Bash");
    expect(toolSummary("Read", { path: "src/main.ts" })).toBe("Read src/main.ts");
  });

  it("labels a run of shell aliases as Bash calls", () => {
    const wrapper = mount(ToolRunBlock, {
      props: {
        items: [
          tool("one", "shell_command", { command: "npm test" }),
          tool("two", "exec_command", JSON.stringify({ cmd: "npm run build" }))
        ]
      }
    });

    expect(wrapper.get(".cw-tool-run-count").text()).toBe("2 Bash calls");
    expect(wrapper.get(".cw-tool-run-summary").text()).toBe("Bash: npm test -> Bash: npm run build");
  });

  it("labels a heterogeneous run as generic tool calls", () => {
    const wrapper = mount(ToolRunBlock, {
      props: {
        items: [
          tool("one", "shell_command", { command: "npm test" }),
          tool("two", "Read", { path: "src/main.ts" })
        ]
      }
    });

    expect(wrapper.get(".cw-tool-run-count").text()).toBe("2 tool calls");
  });
});

function tool(key: string, toolName: string, toolInput: unknown): NormalizedBlock {
  return {
    key,
    index: key.length,
    sourceIndexes: [key.length],
    agent: "codex",
    kind: "tool",
    toolUseId: `call-${key}`,
    toolName,
    toolInput,
    toolResult: "ok",
    matched: true
  };
}
