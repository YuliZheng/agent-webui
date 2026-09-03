import { describe, expect, it } from "vitest";
import { splitInlineVisualizations } from "../src/util/inline-visualization.js";

describe("Codex inline visualization directives", () => {
  it("splits safe HTML directives from surrounding assistant text", () => {
    expect(splitInlineVisualizations(
      'Summary\n\n::codex-inline-vis{file="chart.html"}\n\nDone',
    )).toEqual([
      { kind: "text", text: "Summary\n\n" },
      { kind: "visualization", file: "chart.html" },
      { kind: "text", text: "\n\nDone" },
    ]);
  });

  it("does not turn path traversal into an iframe", () => {
    const text = '::codex-inline-vis{file="../secret.html"}';
    expect(splitInlineVisualizations(text)).toEqual([{ kind: "text", text }]);
  });

  it("does not render a directive shown as inline code or prose", () => {
    const inline = 'Example: `::codex-inline-vis{file="example.html"}`';
    const prose = 'Use ::codex-inline-vis{file="example.html"} to embed it.';
    expect(splitInlineVisualizations(inline)).toEqual([{ kind: "text", text: inline }]);
    expect(splitInlineVisualizations(prose)).toEqual([{ kind: "text", text: prose }]);
  });

  it("does not render directive examples inside fenced code", () => {
    const text = [
      "```text",
      '::codex-inline-vis{file="example.html"}',
      "```",
      "",
      "~~~",
      '::codex-inline-vis{file="other.html"}',
      "~~~",
    ].join("\n");
    expect(splitInlineVisualizations(text)).toEqual([{ kind: "text", text }]);
  });

  it("requires the directive to occupy its own unindented line", () => {
    const indented = '    ::codex-inline-vis{file="example.html"}';
    expect(splitInlineVisualizations(indented)).toEqual([{ kind: "text", text: indented }]);
  });
});
