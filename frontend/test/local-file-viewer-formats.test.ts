import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const viewer = readFileSync(join(process.cwd(), "src/components/LocalFileViewer.vue"), "utf8");
const backend = readFileSync(join(process.cwd(), "../backend/src/app.ts"), "utf8");

describe("local file format previews", () => {
  it("renders Markdown and sandboxes arbitrary local HTML", () => {
    expect(viewer).toContain("renderMarkdown");
    expect(viewer).toContain("v-html=\"markdownHtml\"");
    expect(viewer).toContain("sandbox=\"\"");
    expect(viewer).toContain(":srcdoc=\"htmlDocument\"");
  });

  it("embeds PDFs and always offers an authenticated download", () => {
    expect(viewer).toContain("previewKind === 'pdf'");
    expect(viewer).toContain(":href=\"downloadUrl\"");
    expect(backend).toContain('app.get("/api/local-file-content"');
    expect(backend).toContain('Content-Disposition');
    expect(backend).toContain('Only PDF files can be embedded through this endpoint');
  });

  it("browses directories and keeps media download-only", () => {
    expect(viewer).toContain("listLocalDirectory");
    expect(viewer).toContain("directory.entries");
    expect(viewer).toContain("Open folder links on PC");
    expect(viewer).toContain("Media stays download-only");
    expect(backend).toContain('case "inspect-local-path"');
    expect(backend).toContain('case "list-local-directory"');
  });
});
