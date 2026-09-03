import { describe, expect, it } from "vitest";
import { extractToolResultImages, extractToolRunImages } from "../src/util/tool-result-images.js";

describe("tool-result image bubbles", () => {
  it("extracts Claude, MCP, URL, and serialized Codex image blocks", () => {
    expect(extractToolResultImages([
      { type: "text", text: "ready" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      },
      { type: "image", source: { type: "url", url: "https://example.test/x.png" } },
      { type: "image", mimeType: "image/webp", data: "d29ybGQ=" },
      { type: "image_url", image_url: { url: "https://example.test/y.png" } },
      { type: "image_url", image_url: "/api/sessions/session-1/transcript-image/27/3" },
    ])).toEqual([
      { url: "data:image/png;base64,aGVsbG8=" },
      { url: "https://example.test/x.png" },
      { url: "data:image/webp;base64,d29ybGQ=" },
      { url: "https://example.test/y.png" },
      { url: "/api/sessions/session-1/transcript-image/27/3" },
    ]);
    expect(extractToolResultImages(JSON.stringify({
      content: [{ type: "input_image", image_url: "data:image/png;base64,aA==" }],
    }))).toEqual([{ url: "data:image/png;base64,aA==" }]);
  });

  it("promotes and deduplicates images from a collapsed run of tool results", () => {
    expect(extractToolRunImages([
      [{ type: "image_url", image_url: "/api/sessions/s1/transcript-image/10/0?v=a" }],
      [
        { type: "image_url", image_url: "/api/sessions/s1/transcript-image/10/0?v=a" },
        { type: "input_image", image_url: "data:image/jpeg;base64,aA==" },
      ],
    ])).toEqual([
      { url: "/api/sessions/s1/transcript-image/10/0?v=a" },
      { url: "data:image/jpeg;base64,aA==" },
    ]);
  });
});
