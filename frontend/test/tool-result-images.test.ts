import { describe, expect, it } from "vitest";
import { extractToolResultImages } from "../src/util/tool-result-images.js";

describe("tool-result image bubbles", () => {
  it("extracts only valid base64 image blocks", () => {
    expect(extractToolResultImages([
      { type: "text", text: "ready" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      },
      { type: "image", source: { type: "url", url: "https://example.test/x.png" } },
    ])).toEqual([
      { url: "data:image/png;base64,aGVsbG8=" },
    ]);
  });
});
