import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import type { HighlighterCore } from "shiki/core";

let highlighter: HighlighterCore | undefined;
let loading: Promise<void> | undefined;

const escapeHtml = (source: string): string => source.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code: string, lang: string): string {
    if (highlighter) {
      try { return highlighter.codeToHtml(code, { lang: lang || "text", theme: "github-dark-default" }); } catch { /* unknown language */ }
    }
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
});

export function warmMarkdownHighlighter(): Promise<void> {
  return loading ??= Promise.all([
    import("shiki/core"), import("shiki/engine/oniguruma"), import("@shikijs/engine-oniguruma/wasm-inlined")
  ]).then(async ([{ createHighlighterCore }, { createOnigurumaEngine }, { default: getWasm }]) => {
    highlighter = await createHighlighterCore({
      themes: [import("@shikijs/themes/github-dark-default")],
      langs: [
        import("@shikijs/langs/typescript"), import("@shikijs/langs/javascript"), import("@shikijs/langs/json"),
        import("@shikijs/langs/bash"), import("@shikijs/langs/python"), import("@shikijs/langs/css"),
        import("@shikijs/langs/html"), import("@shikijs/langs/markdown")
      ],
      engine: createOnigurumaEngine(getWasm)
    });
  }).catch(() => undefined);
}

export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(md.render(source), { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "iframe", "script"] });
}
