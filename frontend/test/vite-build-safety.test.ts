import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("production build safety", () => {
  it("does not empty the live frontend directory before a build succeeds", async () => {
    const config = await readFile(resolve(process.cwd(), "vite.config.ts"), "utf8");

    expect(config).toContain("emptyOutDir: false");
  });

  it("keeps frontend type checks from emitting alongside source files", async () => {
    const config = JSON.parse(
      await readFile(resolve(process.cwd(), "tsconfig.json"), "utf8"),
    ) as { compilerOptions?: { noEmit?: unknown } };

    expect(config.compilerOptions?.noEmit).toBe(true);
  });

  it("collects only TypeScript tests even if stray JavaScript output exists", async () => {
    const config = await readFile(resolve(process.cwd(), "vitest.config.ts"), "utf8");

    expect(config).toContain('include: ["test/**/*.test.ts"]');
  });
});
