import { describe, expect, it } from "vitest";
import { renderMarkdown, renderUserMarkdown } from "../src/render/markdown";

describe("markdown rendering pipeline", () => {
  it("keeps assistant soft line breaks and preserves user composer line breaks", () => {
    expect(renderMarkdown("first line\nsecond line")).not.toContain("<br");
    expect(renderUserMarkdown("first line\nsecond line")).toContain("<br");
  });

  it("wraps tables and hardens external links", () => {
    const html = renderMarkdown([
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "[OpenAI](https://openai.com)",
    ].join("\n"));
    expect(html).toContain('<div class="md-table-wrap"><table>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
  });

  it("renders task-list checkboxes and KaTeX math", () => {
    const html = renderMarkdown("- [ ] pending\n- [x] done\n\n$x^2$");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("task-list-item");
    expect(html).toContain("katex");
  });
});
