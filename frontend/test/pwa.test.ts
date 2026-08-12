import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const mainTs = readFileSync(join(root, "src/main.ts"), "utf8");
const frontendUpdate = readFileSync(join(root, "src/util/frontend-update.ts"), "utf8");
const serviceWorker = readFileSync(join(root, "public/sw.js"), "utf8");
const manifest = JSON.parse(
  readFileSync(join(root, "public/manifest.webmanifest"), "utf8"),
) as {
  id?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  orientation?: string;
  icons?: Array<{ src?: string; sizes?: string; type?: string }>;
};

describe("PWA install support", () => {
  it("links a scoped standalone manifest whose install icons match the favicon", () => {
    expect(indexHtml).toContain('rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"');
    expect(indexHtml).toContain('name="mobile-web-app-capable" content="yes"');
    expect(manifest).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "portrait",
    });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: "/assets/icon-192.png", sizes: "192x192", type: "image/png" }),
      expect.objectContaining({
        src: "/favicon-1780988963583-transparent.png",
        sizes: "512x512",
        type: "image/png",
      }),
    ]));
    expect(manifest.icons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ src: "/clawd.svg" }),
    ]));
  });

  it("registers only in secure production contexts", () => {
    expect(mainTs).toContain("import.meta.env.PROD && window.isSecureContext");
    expect(mainTs).toContain('.register("/sw.js", { scope: "/", updateViaCache: "none" })');
  });

  it("checks the network shell on foreground and reloads only after transient state is safe", () => {
    expect(mainTs).toContain("watchForFrontendUpdates(registration, canReloadForFrontendUpdate)");
    expect(mainTs).toContain("drafts.inflightBySession");
    expect(mainTs).toContain("imageDrafts.bySession");
    expect(mainTs).toContain("focusedComposerHasDraft");
    expect(mainTs).toContain("drafts.text(selectedId).length > 0");
    expect(mainTs).toContain('sessions.statusBySession[selectedId] === "running"');
    expect(frontendUpdate).toContain('fetch("/", {');
    expect(frontendUpdate).toContain('cache: "no-store"');
    expect(frontendUpdate).toContain('registration.update()');
    expect(frontendUpdate).toContain('"controllerchange"');
    expect(frontendUpdate).toContain('"visibilitychange"');
  });

  it("keeps the service-worker cache limited to public shell assets", () => {
    expect(serviceWorker).toContain('request.method !== "GET"');
    expect(serviceWorker).toContain('url.pathname.startsWith("/assets/")');
    expect(serviceWorker).toContain("if (!isNavigation && !isStaticAsset) return");
    expect(serviceWorker).not.toContain("/api/");
    expect(serviceWorker).not.toContain("/attachments/");
  });

  it("bounds navigation freshness waits and reuses immutable hashed assets", () => {
    expect(serviceWorker).toContain('CACHE_NAME = `${CACHE_PREFIX}v2`');
    expect(serviceWorker).toContain("NAVIGATION_NETWORK_BUDGET_MS = 750");
    expect(serviceWorker).toContain("Promise.race([networkResponse, cachedAfterBudget])");
    expect(serviceWorker).toContain("event.waitUntil(networkResponse");
    expect(serviceWorker).toContain("if (isHashedAsset)");
    expect(serviceWorker).toContain("cacheFirst(request)");
  });
});
