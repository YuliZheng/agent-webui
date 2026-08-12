export type InlineVisualizationPart =
  | { kind: "text"; text: string }
  | { kind: "visualization"; file: string };

const DIRECTIVE_RE = /::codex-inline-vis\{\s*file=(?:"([^"]+)"|'([^']+)')\s*\}/g;
const SAFE_HTML_FILE_RE = /^[^\\/\0]+\.html?$/i;

export function splitInlineVisualizations(text: string): InlineVisualizationPart[] {
  const parts: InlineVisualizationPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(DIRECTIVE_RE)) {
    const index = match.index ?? 0;
    const file = match[1] ?? match[2] ?? "";
    if (!SAFE_HTML_FILE_RE.test(file)) continue;
    if (index > cursor) parts.push({ kind: "text", text: text.slice(cursor, index) });
    parts.push({ kind: "visualization", file });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts.length ? parts : [{ kind: "text", text }];
}
