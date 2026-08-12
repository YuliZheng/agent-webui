import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePwaName } from "../../scripts/configure-pwa-name.mjs";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe("per-instance PWA naming", () => {
  it("gives the Mac instance its own install identity and display name", async () => {
    const dist = await mkdtemp(join(tmpdir(), "agent-webui-pwa-name-"));
    cleanup.push(dist);
    await writeFile(join(dist, "manifest.webmanifest"), JSON.stringify({
      name: "Agent WebUI", short_name: "Agent", start_url: "/", scope: "/",
    }));
    await writeFile(join(dist, "index.html"), [
      '<meta name="apple-mobile-web-app-title" content="Agent WebUI" />',
      '<link rel="manifest" href="/manifest.webmanifest" />',
      "<title>Agent WebUI</title>",
    ].join("\n"));

    await configurePwaName({
      distDir: dist,
      name: "agent-macbook",
      id: "/agent-macbook-38485",
      startUrl: "/agent-macbook-38485/",
      scope: "/agent-macbook-38485/",
    });

    const manifest = JSON.parse(await readFile(join(dist, "manifest.webmanifest"), "utf8"));
    expect(manifest).toMatchObject({
      name: "agent-macbook",
      short_name: "agent-macbook",
      id: "/agent-macbook-38485",
      start_url: "/agent-macbook-38485/",
      scope: "/agent-macbook-38485/",
    });
    const html = await readFile(join(dist, "index.html"), "utf8");
    expect(html).toContain('content="agent-macbook"');
    expect(html).toContain("<title>agent-macbook</title>");
    expect(html).toContain(
      'href="/manifest.webmanifest?instance=agent-macbook-38485"',
    );
  });

  it("keys the Mac identity to the public Relay port, not the backend port", async () => {
    const installer = await readFile(
      join(process.cwd(), "..", "scripts", "install-agent-webui-macos.mjs"),
      "utf8",
    );
    expect(installer).toContain('value("--public-port") ?? 38485');
    expect(installer).toContain('`/agent-macbook-${publicPort}`');
  });
});
