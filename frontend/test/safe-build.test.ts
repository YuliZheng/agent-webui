import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  publishFrontendBuild,
  validateFrontendBuild,
} from "../../scripts/build-frontend-safe.mjs";

const cleanup: string[] = [];

async function fixture(name: string, entry: string) {
  const root = await mkdtemp(join(tmpdir(), `agent-webui-${name}-`));
  cleanup.push(root);
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "assets", `${entry}.js`), `globalThis.${entry} = true;\n`);
  await writeFile(
    join(root, "index.html"),
    `<div id="app"></div><script type="module" src="/assets/${entry}.js"></script>`,
  );
  return root;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("safe frontend publishing", () => {
  it("retains old hashed assets and commits a fully validated new index", async () => {
    const live = await fixture("live", "old");
    const staged = await fixture("staged", "new");

    await publishFrontendBuild({ stagedDir: staged, liveDir: live });

    expect(await readFile(join(live, "index.html"), "utf8")).toContain("/assets/new.js");
    expect(await readFile(join(live, "assets", "new.js"), "utf8")).toContain("new = true");
    expect(await readFile(join(live, "assets", "old.js"), "utf8")).toContain("old = true");
  });

  it("rejects an incomplete build before touching the live index", async () => {
    const live = await fixture("live", "old");
    const staged = await fixture("staged", "missing");
    await rm(join(staged, "assets", "missing.js"));

    await expect(validateFrontendBuild(staged)).rejects.toThrow(
      "Staged frontend reference is missing",
    );
    await expect(publishFrontendBuild({ stagedDir: staged, liveDir: live })).rejects.toThrow(
      "Staged frontend reference is missing",
    );
    expect(await readFile(join(live, "index.html"), "utf8")).toContain("/assets/old.js");
  });

  it("keeps either concurrent publisher coherent", async () => {
    const live = await fixture("live", "old");
    const stagedA = await fixture("staged-a", "alpha");
    const stagedB = await fixture("staged-b", "beta");

    await Promise.all([
      publishFrontendBuild({ stagedDir: stagedA, liveDir: live }),
      publishFrontendBuild({ stagedDir: stagedB, liveDir: live }),
    ]);

    const html = await readFile(join(live, "index.html"), "utf8");
    const selected = html.includes("alpha.js") ? "alpha" : "beta";
    expect(html).toContain(`/assets/${selected}.js`);
    expect(await readFile(join(live, "assets", `${selected}.js`), "utf8")).toContain(
      `${selected} = true`,
    );
  });
});
