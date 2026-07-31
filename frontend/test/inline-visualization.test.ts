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
});
