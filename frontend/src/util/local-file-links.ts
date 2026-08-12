export interface LocalFileLink {
  path: string;
  line: number | null;
  isImage: boolean;
  openInSystem: boolean;
}

const LOCAL_ABSOLUTE_PATH_RE = /^\/(?:physical|home|ak|tmp)\//;
const LOCAL_IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i;
const LOCAL_MARKDOWN_EXT_RE = /\.(?:md|markdown|mdown)$/i;
const LOCAL_HTML_EXT_RE = /\.html?$/i;
const LOCAL_PDF_EXT_RE = /\.pdf$/i;
const LOCAL_AUDIO_EXT_RE = /\.(?:aac|flac|m4a|mp3|ogg|opus|wav)$/i;
const LOCAL_VIDEO_EXT_RE = /\.(?:avi|m4v|mkv|mov|mp4|mpeg|mpg|webm)$/i;
const LOCAL_TEXT_EXT_RE = /\.(?:txt|text|log|csv|tsv|json|jsonl|ya?ml|toml|ini|conf|cfg|xml|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|vue|svelte|py|rb|php|java|kt|kts|c|cc|cpp|h|hpp|cs|go|rs|sh|bash|zsh|fish|ps1|sql|graphql|gql|env|gitignore|dockerfile)$/i;

export type LocalFilePreviewKind = "image" | "markdown" | "html" | "pdf" | "text" | "audio" | "video" | "binary";

export function localFilePreviewKind(path: string): LocalFilePreviewKind {
  if (LOCAL_IMAGE_EXT_RE.test(path)) return "image";
  if (LOCAL_MARKDOWN_EXT_RE.test(path)) return "markdown";
  if (LOCAL_HTML_EXT_RE.test(path)) return "html";
  if (LOCAL_PDF_EXT_RE.test(path)) return "pdf";
  if (LOCAL_TEXT_EXT_RE.test(path)) return "text";
  if (LOCAL_AUDIO_EXT_RE.test(path)) return "audio";
  if (LOCAL_VIDEO_EXT_RE.test(path)) return "video";
  return "binary";
}

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
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function localFileFromHref(href: string, baseHref: string): LocalFileLink | null {
  // markdown-it preserves a Windows drive path as a custom-scheme href,
  // encoding backslashes along the way (C:%5CUsers%5C...). Browsers cannot
  // navigate that URL, so recognize it before URL origin validation and route
  // it into the authenticated in-app file viewer.
  let decodedHref: string;
  try { decodedHref = decodeURIComponent(href); } catch { decodedHref = href; }
  const windowsHash = /#L?([1-9][0-9]*)$/.exec(decodedHref);
  const windowsPath = windowsHash ? decodedHref.slice(0, windowsHash.index) : decodedHref;
  if (/^[A-Za-z]:[\\/]/.test(windowsPath)) {
    const parsed = splitLineSuffix(windowsPath);
    return {
      path: parsed.path,
      line: parsed.line ?? (windowsHash ? Number(windowsHash[1]) : null),
      isImage: isLocalImagePath(parsed.path),
      openInSystem: false,
    };
  }

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
      openInSystem: false,
    };
  }

  let decodedPath: string;
  try { decodedPath = decodeURIComponent(url.pathname); } catch { return null; }

  // Browsers turn a Markdown href such as C:/Users/Alice/report.md into a
  // same-origin URL path (/C:/Users/Alice/report.md). Recover the Windows path
  // instead of treating it as a remote route.
  if (/^\/[A-Za-z]:[\\/]/.test(decodedPath)) {
    const parsed = splitLineSuffix(decodedPath.slice(1));
    return {
      path: parsed.path,
      line: parsed.line ?? lineFromHash(url.hash),
      isImage: isLocalImagePath(parsed.path),
      openInSystem: false,
    };
  }

  // Markdown file links emitted by Codex are absolute-path hrefs, e.g.
  // /physical/.../backend/src/app.ts:12. Intercept them inside the already
  // authenticated webui instead of opening a new top-level proxied page.
  if (!LOCAL_ABSOLUTE_PATH_RE.test(url.pathname)) return null;
  const parsed = splitLineSuffix(decodedPath);
  return {
    path: parsed.path,
    line: parsed.line ?? lineFromHash(url.hash),
    isImage: isLocalImagePath(parsed.path),
    openInSystem: false,
  };
}
