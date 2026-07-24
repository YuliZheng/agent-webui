import DOMPurify from "dompurify";
import katex from "katex";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import texmath from "markdown-it-texmath";

function configureMarkdown(breaks: boolean): MarkdownIt {
  const instance = new MarkdownIt({
    breaks,
    html: false,
    linkify: true,
    typographer: false,
  });

  instance.use(taskLists, {
    enabled: false,
    label: true,
    labelAfter: true,
  });
  instance.use(texmath, {
    engine: katex,
    delimiters: "dollars",
    katexOptions: {
      throwOnError: false,
      strict: false,
      output: "htmlAndMathml",
    },
  });

  const tableOpen = instance.renderer.rules.table_open
    ?? ((tokens, index, options, _env, renderer) => renderer.renderToken(tokens, index, options));
  const tableClose = instance.renderer.rules.table_close
    ?? ((tokens, index, options, _env, renderer) => renderer.renderToken(tokens, index, options));
  instance.renderer.rules.table_open = (tokens, index, options, env, renderer) =>
    `<div class="md-table-wrap">${tableOpen(tokens, index, options, env, renderer)}`;
  instance.renderer.rules.table_close = (tokens, index, options, env, renderer) =>
    `${tableClose(tokens, index, options, env, renderer)}</div>`;

  const linkOpen = instance.renderer.rules.link_open
    ?? ((tokens, index, options, _env, renderer) => renderer.renderToken(tokens, index, options));
  instance.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const token = tokens[index]!;
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener");
    return linkOpen(tokens, index, options, env, renderer);
  };
  return instance;
}

// Assistant and system prose preserves Markdown's normal soft-wrap behavior.
// User prompts keep physical line breaks because the composer is plain text.
const md = configureMarkdown(false);
const mdUser = configureMarkdown(true);

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["checked", "disabled", "rel", "target"],
  });
}

export function renderMarkdown(source: string): string {
  return sanitize(md.render(source));
}

export function renderUserMarkdown(source: string): string {
  return sanitize(mdUser.render(source));
}
