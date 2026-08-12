import { describe, expect, it } from "vitest";
import { themedVisualizationHtml } from "../src/services/visualization.js";

describe("sandboxed visualization document", () => {
  it("wraps Codex HTML fragments with fallback theme variables", () => {
    const html = themedVisualizationHtml(
      '<svg><text style="fill:var(--foreground)">visible</text></svg>',
    );
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("--foreground: #111827");
    expect(html).toContain("--viz-series-4: #8b5cf6");
    expect(html).toContain("<body><svg>");
  });

  it("injects the theme into a complete document head", () => {
    const html = themedVisualizationHtml(
      "<!doctype html><html><head><title>Chart</title></head><body>ok</body></html>",
    );
    expect(html.indexOf("agent-webui-visualization-theme")).toBeLessThan(
      html.indexOf("<title>Chart</title>"),
    );
    expect(html.match(/<html/g)).toHaveLength(1);
  });
});
