import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function htmlEscape(value) {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function slug(value) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent-webui";
}

export async function configurePwaName({ distDir, name, id, startUrl, scope }) {
  const normalizedName = String(name ?? "").trim();
  if (!normalizedName || normalizedName.length > 64) {
    throw new Error("PWA name must contain 1-64 characters");
  }

  const root = resolve(distDir);
  const manifestPath = resolve(root, "manifest.webmanifest");
  const indexPath = resolve(root, "index.html");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = normalizedName;
  manifest.short_name = normalizedName;
  manifest.id = id || `/${slug(normalizedName)}`;
  if (startUrl) manifest.start_url = startUrl;
  if (scope) manifest.scope = scope;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const escaped = htmlEscape(normalizedName);
  let html = await readFile(indexPath, "utf8");
  html = html.replace(
    /(<meta\s+name=["']apple-mobile-web-app-title["']\s+content=)["'][^"']*["']/i,
    `$1"${escaped}"`,
  );
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escaped}</title>`);
  const manifestVersion = encodeURIComponent(String(manifest.id).replace(/^\//, ""));
  html = html.replace(
    /(<link\s+rel=["']manifest["'][^>]*\shref=)["'][^"']*["']/i,
    `$1"/manifest.webmanifest?instance=${manifestVersion}"`,
  );
  await writeFile(indexPath, html, "utf8");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const value = flag => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  await configurePwaName({
    distDir: value("--dist") ?? "frontend/dist",
    name: value("--name"),
    id: value("--id"),
    startUrl: value("--start-url"),
    scope: value("--scope"),
  });
}
