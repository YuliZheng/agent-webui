export type InlineVisualizationPart =
  | { kind: "text"; text: string }
  | { kind: "visualization"; file: string };

const DIRECTIVE_LINE_RE = /^::codex-inline-vis\{\s*file=(?:"([^"]+)"|'([^']+)')\s*\}$/;
const SAFE_HTML_FILE_RE = /^[^\\/\0]+\.html?$/i;

export function splitInlineVisualizations(text: string): InlineVisualizationPart[] {
  const directives: Array<{ start: number; end: number; file: string }> = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const rawLine = text.slice(lineStart, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)\s*$/);
      if (
        closing
        && closing[1]?.[0] === fence.marker
        && closing[1].length >= fence.length
      ) fence = undefined;
    } else {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (opening?.[1]) {
        fence = {
          marker: opening[1][0] as "`" | "~",
          length: opening[1].length,
        };
      } else {
        const directive = line.match(DIRECTIVE_LINE_RE);
        const file = directive?.[1] ?? directive?.[2] ?? "";
        if (directive && SAFE_HTML_FILE_RE.test(file)) {
          directives.push({ start: lineStart, end: lineEnd, file });
        }
      }
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  if (!directives.length) return [{ kind: "text", text }];

  const parts: InlineVisualizationPart[] = [];
  let cursor = 0;
  for (const directive of directives) {
    if (directive.start > cursor) {
      parts.push({ kind: "text", text: text.slice(cursor, directive.start) });
    }
    parts.push({ kind: "visualization", file: directive.file });
    cursor = directive.end;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts;
}
