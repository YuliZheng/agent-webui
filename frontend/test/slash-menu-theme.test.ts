import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("slash menu theme contract", () => {
  it("uses semantic theme tokens without hard-coded light/dark surfaces", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/SlashCommandMenu.vue"),
      "utf8",
    );

    for (const token of ["--cw-panel-bg", "--cw-panel-2", "--cw-border", "--cw-text", "--cw-muted", "--cw-accent"]) {
      expect(source).toContain(token);
    }
    expect(source).not.toContain("bg-white");
    expect(source).not.toContain("bg-gray");
    expect(source).not.toContain("dark:bg-");
    expect(source).not.toContain("dark:text-");
  });
});
