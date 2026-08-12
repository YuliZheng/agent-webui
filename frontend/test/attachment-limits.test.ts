import { describe, expect, it } from "vitest";
import { promptAttachmentError } from "../src/util/attachment-limits.js";

const mib = 1024 * 1024;
const images = (count: number, bytes = 1) => Array.from({ length: count }, () => ({ bytes }));

describe("prompt attachment limits", () => {
  it("allows the Codex 21 + 10 image use case when sent as two messages", () => {
    expect(promptAttachmentError(images(21), "codex")).toBeNull();
    expect(promptAttachmentError(images(10), "codex")).toBeNull();
  });

  it("keeps Claude's lower attachment-count limit", () => {
    expect(promptAttachmentError(images(8), "claude")).toBeNull();
    expect(promptAttachmentError(images(9), "claude")).toContain("up to 8");
  });

  it("rejects before optimistic thinking when Codex count or total bytes are too large", () => {
    expect(promptAttachmentError(images(33), "codex")).toContain("up to 32");
    expect(promptAttachmentError([{ bytes: 40 * mib + 1 }], "codex")).toContain("40 MiB");
  });
});
