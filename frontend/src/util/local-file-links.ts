export interface LocalFileLink {
  path: string;
  line: number | null;
  isImage: boolean;
}

const LOCAL_ABSOLUTE_PATH_RE = /^\/(?:physical|home|ak|tmp)\//;
const LOCAL_IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;

function lineFromHash(hash: string): number | null {
  const m = /^#L?([1-9][0-9]*)$/.exec(hash);
  return m ? Number(m[1]) : null;
}

function splitLineSuffix(pathname: string): { path: string; line: number | null } {
  const suffix = /^(.*):([1-9][0-9]*)$/.exec(pathname);
  if (!suffix) return { path: pathname, line: null };
  return { path: suffix[1]!, line: Number(suffix[2]) };
}

export function isLocalImagePath(path: string): boolean {
  return LOCAL_IMAGE_EXT_RE.test(path);
}

export function codexImageUrl(path: string): string {
  return `/api/codex-image?path=${encodeURIComponent(path)}`;
}

export function basenameFromPath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function localFileFromHref(href: string, baseHref: string): LocalFileLink | null {
  let url: URL;
  let base: URL;
  try {
    url = new URL(href, baseHref);
    base = new URL(baseHref);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;

  if (url.pathname === "/local-file") {
    const file = url.searchParams.get("path") ?? "";
    if (!file) return null;
    const qLine = url.searchParams.get("line");
    const line = qLine && /^[1-9][0-9]*$/.test(qLine) ? Number(qLine) : lineFromHash(url.hash);
    return {
      path: file,
      line,
      isImage: isLocalImagePath(file),
    };
  }

  // Markdown file links emitted by Codex are absolute-path hrefs, e.g.
  // /physical/.../backend/src/app.ts:12. Intercept them inside the already
  // authenticated webui instead of opening a new top-level proxied page.
  if (!LOCAL_ABSOLUTE_PATH_RE.test(url.pathname)) return null;
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(url.pathname); } catch { return null; }
  const parsed = splitLineSuffix(decodedPath);
  return {
    path: parsed.path,
    line: parsed.line ?? lineFromHash(url.hash),
    isImage: isLocalImagePath(parsed.path),
  };
}
