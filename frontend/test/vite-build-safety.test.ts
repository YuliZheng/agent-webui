import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("production build safety", () => {
  it("does not empty the live frontend directory before a build succeeds", async () => {
    const config = await readFile(resolve(process.cwd(), "vite.config.ts"), "utf8");

    expect(config).toContain("emptyOutDir: false");
  });
});
