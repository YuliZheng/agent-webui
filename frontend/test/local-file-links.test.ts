import { describe, expect, it } from "vitest";
import {
  basenameFromPath,
  codexImageUrl,
  localFileFromHref,
  localFilePreviewKind,
} from "../src/util/local-file-links.js";

const BASE = "https://claude-webui.test/chat";

describe("local file links", () => {
  it("parses source links with a line suffix", () => {
    expect(localFileFromHref("/home/alice/claude-webui/src/app.ts:12", BASE)).toEqual({
      path: "/home/alice/claude-webui/src/app.ts",
      line: 12,
      isImage: false,
      openInSystem: false,
    });
  });

  it("recognizes local image links before they reach the source viewer", () => {
    expect(localFileFromHref("/home/alice/tmp/coreinsight.PNG", BASE)).toEqual({
      path: "/home/alice/tmp/coreinsight.PNG",
      line: null,
      isImage: true,
      openInSystem: false,
    });
  });

  it("recognizes images behind /local-file query links", () => {
    expect(localFileFromHref("/local-file?path=%2Fhome%2Falice%2Ftmp%2Fplot.png", BASE)).toEqual({
      path: "/home/alice/tmp/plot.png",
      line: null,
      isImage: true,
      openInSystem: false,
    });
  });

  it("recognizes markdown-it encoded Windows paths for the in-app viewer", () => {
    expect(localFileFromHref("C:%5CUsers%5CAlice%5CPrivate%20Files%5CREADME.md", BASE)).toEqual({
      path: "C:\\Users\\Alice\\Private Files\\README.md",
      line: null,
      isImage: false,
      openInSystem: false,
    });
  });

  it("recognizes forward-slash Windows paths and source line suffixes", () => {
    expect(localFileFromHref("C:/work/project/src/app.ts:19", BASE)).toEqual({
      path: "C:/work/project/src/app.ts",
      line: 19,
      isImage: false,
      openInSystem: false,
    });
  });

  it("opens Windows image paths in the WebUI lightbox instead of host Explorer", () => {
    expect(localFileFromHref("C:%5CUsers%5CAlice%5CPictures%5Cbald.png", BASE)).toEqual({
      path: "C:\\Users\\Alice\\Pictures\\bald.png",
      line: null,
      isImage: true,
      openInSystem: false,
    });
  });

  it("recovers Windows paths that browsers expanded into same-origin URLs", () => {
    expect(localFileFromHref(
      "https://claude-webui.test/C:/Users/Alice/Travel/%E4%BD%8F%E5%AE%BF/Info.md",
      BASE,
    )).toEqual({
      path: "C:/Users/Alice/Travel/住宿/Info.md",
      line: null,
      isImage: false,
      openInSystem: false,
    });
  });

  it("ignores external links", () => {
    expect(localFileFromHref("https://example.com/home/alice/tmp/plot.png", BASE)).toBeNull();
  });

  it("builds codex image URLs and labels", () => {
    expect(codexImageUrl("/home/alice/tmp/a b.png")).toBe("/api/codex-image?path=%2Fhome%2Falice%2Ftmp%2Fa%20b.png");
    expect(basenameFromPath("/home/alice/tmp/a b.png")).toBe("a b.png");
    expect(basenameFromPath("C:\\Users\\alice\\README.md")).toBe("README.md");
  });

  it("classifies common local file preview formats", () => {
    expect(localFilePreviewKind("README.md")).toBe("markdown");
    expect(localFilePreviewKind("report.HTML")).toBe("html");
    expect(localFilePreviewKind("ticket.pdf")).toBe("pdf");
    expect(localFilePreviewKind("notes.txt")).toBe("text");
    expect(localFilePreviewKind("photo.avif")).toBe("image");
    expect(localFilePreviewKind("recording.m4a")).toBe("audio");
    expect(localFilePreviewKind("movie.MP4")).toBe("video");
    expect(localFilePreviewKind("archive.zip")).toBe("binary");
  });
});
