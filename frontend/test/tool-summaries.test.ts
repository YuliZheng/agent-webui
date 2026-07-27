import { describe, it, expect } from "vitest";
import { toolSummary } from "../src/parser/tool-summaries.js";

describe("toolSummary", () => {
  it("Bash uses description", () => {
    expect(toolSummary("Bash", { description: "List dir", command: "ls" }))
      .toBe("Bash · List dir");
  });
  it("Bash falls back to command first 60 chars", () => {
    expect(toolSummary("Bash", { command: "echo hello" }))
      .toBe("Bash · echo hello");
  });
  it("Read shows file_path and range", () => {
    expect(toolSummary("Read", { file_path: "/x/y.ts", offset: 10, limit: 20 }))
      .toBe("Read · /x/y.ts · L10–L30");
    expect(toolSummary("Read", { file_path: "/x/y.ts" }))
      .toBe("Read · /x/y.ts");
  });
  it("Edit shows file_path", () => {
    expect(toolSummary("Edit", { file_path: "/a.ts" })).toBe("Edit · /a.ts");
  });
  it("Write shows file_path", () => {
    expect(toolSummary("Write", { file_path: "/a.ts", content: "ab\ncd\n" })).toBe("Write · /a.ts · 3 lines");
  });
  it("Grep shows pattern and path", () => {
    expect(toolSummary("Grep", { pattern: "foo", path: "src" })).toBe("Grep · \"foo\" in src");
    expect(toolSummary("Grep", { pattern: "foo" })).toBe("Grep · \"foo\"");
  });
  it("Glob shows pattern", () => {
    expect(toolSummary("Glob", { pattern: "**/*.ts" })).toBe("Glob · **/*.ts");
  });
  it("WebFetch shows url", () => {
    expect(toolSummary("WebFetch", { url: "https://x" })).toBe("WebFetch · https://x");
  });
  it("WebSearch shows query", () => {
    expect(toolSummary("WebSearch", { query: "vue" })).toBe("WebSearch · \"vue\"");
  });
  it("TaskCreate shows subject", () => {
    expect(toolSummary("TaskCreate", { subject: "do x" })).toBe("TaskCreate · do x");
  });
  it("TaskUpdate shows id and status", () => {
    expect(toolSummary("TaskUpdate", { taskId: "7", status: "completed" }))
      .toBe("TaskUpdate · #7 → completed");
  });
  it("Agent shows subagent_type and description", () => {
    expect(toolSummary("Agent", { subagent_type: "explore", description: "find auth" }))
      .toBe("Agent · explore · find auth");
  });
  it("MCP-namespaced tool", () => {
    expect(toolSummary("mcp__server__tool", {})).toBe("MCP · server · tool");
  });
  it("unknown tool falls back", () => {
    expect(toolSummary("MysteryTool", { x: 1 })).toBe("MysteryTool");
  });
});
