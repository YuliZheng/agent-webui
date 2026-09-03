import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/components/blocks/tool/ToolRunBlock.vue"), "utf8");

describe("collapsed tool-run images", () => {
  it("keeps returned images visible while tool details remain folded", () => {
    expect(source).toContain("extractToolRunImages");
    expect(source).toContain('v-if="images.length"');
    expect(source).toContain('class="!h-36 !w-full"');
    expect(source).toContain("hide-result-images");
    expect(source.indexOf('v-if="images.length"')).toBeLessThan(source.indexOf('v-if="open"'));
  });
});
