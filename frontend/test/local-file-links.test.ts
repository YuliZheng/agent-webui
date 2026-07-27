import { describe, expect, it } from "vitest";
import {
  basenameFromPath,
  codexImageUrl,
  localFileFromHref,
} from "../src/util/local-file-links.js";

const BASE = "https://claude-webui.test/chat";

describe("local file links", () => {
  it("parses source links with a line suffix", () => {
    expect(localFileFromHref("/home/alice/claude-webui/src/app.ts:12", BASE)).toEqual({
      path: "/home/alice/claude-webui/src/app.ts",
      line: 12,
      isImage: false,
    });
  });

  it("recognizes local image links before they reach the source viewer", () => {
    expect(localFileFromHref("/home/alice/tmp/coreinsight.PNG", BASE)).toEqual({
      path: "/home/alice/tmp/coreinsight.PNG",
      line: null,
      isImage: true,
    });
  });

  it("recognizes images behind /local-file query links", () => {
    expect(localFileFromHref("/local-file?path=%2Fhome%2Falice%2Ftmp%2Fplot.png", BASE)).toEqual({
      path: "/home/alice/tmp/plot.png",
      line: null,
      isImage: true,
    });
  });

  it("ignores external links", () => {
    expect(localFileFromHref("https://example.com/home/alice/tmp/plot.png", BASE)).toBeNull();
  });

  it("builds codex image URLs and labels", () => {
    expect(codexImageUrl("/home/alice/tmp/a b.png")).toBe("/api/codex-image?path=%2Fhome%2Falice%2Ftmp%2Fa%20b.png");
    expect(basenameFromPath("/home/alice/tmp/a b.png")).toBe("a b.png");
  });
});
