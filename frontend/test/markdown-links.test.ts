import { describe, expect, it } from "vitest";
import { renderMarkdown, renderUserMarkdown } from "../src/render/markdown.js";

describe("message links", () => {
  it.each([renderMarkdown, renderUserMarkdown])(
    "opens explicit and linkified URLs in a separate tab",
    (render) => {
      const html = render("[OpenAI](https://openai.com) https://example.com");
      expect(html.match(/target="_blank"/g)).toHaveLength(2);
      expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
    },
  );
});
