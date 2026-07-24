import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");
const css = readFileSync(join(process.cwd(), "src/styles/index.css"), "utf8");

describe("interactive shell layout", () => {
  it("mounts the composer before the potentially expensive transcript subtree", () => {
    expect(app.indexOf("<ComposerBar")).toBeGreaterThan(0);
    expect(app.indexOf("<ComposerBar")).toBeLessThan(app.indexOf("<TranscriptPane"));
  });
  it("reserves an explicit viewport row for transcript and a bottom row for composer", () => {
    expect(css).toMatch(/\.cw-app\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.cw-main\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto auto auto;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.cw-transcript-frame\s*\{[^}]*grid-row:\s*2;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.cw-composer\s*\{[^}]*grid-row:\s*5;[^}]*position:\s*sticky;[^}]*bottom:\s*0;[^}]*pointer-events:\s*auto;/s);
  });
  it("keeps the transcript as the only vertically scrolling shell surface", () => {
    expect(css).toMatch(/\.cw-transcript-scroll\s*\{[^}]*overflow-y:\s*auto;[^}]*touch-action:\s*pan-y;/s);
  });
  it("does not prefetch background transcripts during application startup", () => {
    expect(app).not.toContain("live.prefetch(");
  });
});
