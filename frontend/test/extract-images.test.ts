import { describe, it, expect } from "vitest";
import { extractAttachedImages } from "../src/util/extract-images.js";

const TRAILER = "Attached files (read with the Read tool to view):";
const LEGACY_TRAILER = "Attached image files (read with the Read tool to view):";

describe("extractAttachedImages", () => {
  it("returns text unchanged when there is no trailer", () => {
    expect(extractAttachedImages("hello")).toEqual({ text: "hello", images: [], pdfs: [] });
  });

  it("splits images and pdfs out of the new-style trailer", () => {
    const raw = `fix this\n\n${TRAILER}\n- /home/x/.claude-webui/images/sid1/1-a.png\n- /home/x/.claude-webui/images/sid1/2-b.pdf`;
    const out = extractAttachedImages(raw);
    expect(out.text).toBe("fix this");
    expect(out.images).toEqual([
      { sid: "sid1", filename: "1-a.png", url: "/api/images/sid1/1-a.png" },
    ]);
    expect(out.pdfs).toEqual([{ sid: "sid1", filename: "2-b.pdf" }]);
  });

  it("still parses the legacy image-only trailer wording", () => {
    const raw = `look\n\n${LEGACY_TRAILER}\n- /home/x/.claude-webui/images/sid2/3-c.jpg`;
    const out = extractAttachedImages(raw);
    expect(out.text).toBe("look");
    expect(out.images).toEqual([
      { sid: "sid2", filename: "3-c.jpg", url: "/api/images/sid2/3-c.jpg" },
    ]);
    expect(out.pdfs).toEqual([]);
  });
});
