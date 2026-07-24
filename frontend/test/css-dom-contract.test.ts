import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const sourceFiles = walk(join(process.cwd(), "src")).filter((file) => /\.(?:ts|vue)$/.test(file));
const source = sourceFiles.map((file) => readFileSync(file, "utf8")).join("\n");
const vueSource = sourceFiles
  .filter((file) => file.endsWith(".vue"))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const css = readFileSync(join(process.cwd(), "src/styles/index.css"), "utf8");

const runtimeThemeClasses = new Set([
  "cw-display-claude-code",
  "cw-display-current",
  "cw-display-wechat",
  "cw-shell-claude-code",
  "cw-shell-current",
  "cw-shell-wechat",
  "cw-style-current",
]);

const retiredClasses = [
  "cw-entry",
  "cw-user-bubble",
  "cw-peer-bubble",
  "cw-bubble-column",
  "cw-avatar-slot",
  "cw-markdown",
  "cw-tool-head",
  "cw-image-bubble",
  "cw-prompt-actions",
  "cw-prompt-collapsed",
  "cw-show-more",
  "cw-sticky-prompt-current",
] as const;

describe("CSS and component DOM contract", () => {
  it("does not retain semantic CSS classes that no component can produce", () => {
    const cssClasses = [...new Set(
      [...css.matchAll(/\.((?:cw-)[A-Za-z0-9_-]+)/g)].map((match) => match[1]!),
    )];
    const orphaned = cssClasses.filter(
      (className) => !runtimeThemeClasses.has(className) && !source.includes(className),
    );
    expect(orphaned).toEqual([]);
  });

  it("styles every explicit cw-* class emitted by a Vue template", () => {
    const templateClasses = [...vueSource.matchAll(/(?:^|\s)class="([^"]+)"/g)]
      .flatMap((match) => match[1]!.split(/\s+/))
      .filter((className) => className.startsWith("cw-"));
    const unstyled = [...new Set(templateClasses)].filter(
      (className) => !css.includes(`.${className}`),
    );
    expect(unstyled).toEqual([]);
  });

  it("keeps retired DOM vocabulary out of both CSS and components", () => {
    for (const className of retiredClasses) {
      expect(css, className).not.toContain(`.${className}`);
      expect(source, className).not.toContain(className);
    }
  });
});
