import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import texmath from "markdown-it-texmath";
import katex from "katex";

// Build a configured markdown-it instance. The ONLY knob that differs between
// our two instances is `breaks`:
//   - false (default, CommonMark): a single newline is a "soft break" → a
//     space. Correct for assistant/system output, which is real markdown where
//     hard-wrapped paragraphs must not sprout <br>s.
//   - true: a single newline becomes a literal <br>. Correct for a USER-typed
//     prompt — pressing Enter in the composer means "line break here", the same
//     way WeChat / Slack / GitHub comment fields treat it. Without this the
//     prompt bubble silently collapses every single newline into a space.
function build(breaks: boolean): MarkdownIt {
  const inst = new MarkdownIt({
    html: false,
    linkify: true,
    breaks,
    typographer: false,
  })
    .use(taskLists, { enabled: false })
    // LaTeX math via KaTeX. delimiters 'dollars' covers Claude's primary style
    // ($..$ inline, $$..$$ display); 'brackets' adds \(..\) and \[..\] which
    // also appear sometimes. texmath's inline-dollar rule already guards
    // against currency ($5.99) by rejecting digit-after-close and whitespace
    // adjacency. throwOnError:false makes a malformed expression render as
    // red source text instead of breaking the whole bubble.
    .use(texmath, {
      engine: katex,
      delimiters: ["dollars", "brackets"],
      katexOptions: { throwOnError: false, output: "html" },
    });

  // Wrap every <table> in a horizontally-scrollable div. Without this, a wide
  // table (e.g., a 6-column comparison table) blows past the viewport on mobile
  // and pushes the entire chat layout sideways — `body { overflow-x: hidden }`
  // then clips the right side and the user can never see the rightmost columns.
  // `overflow-x: auto` on a wrapper isolates the scroll to just the table.
  const defaultTableOpen = inst.renderer.rules.table_open ??
    ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  const defaultTableClose = inst.renderer.rules.table_close ??
    ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));

  inst.renderer.rules.table_open = (tokens, idx, opts, env, self) =>
    `<div class="md-table-wrap">${defaultTableOpen(tokens, idx, opts, env, self)}`;

  inst.renderer.rules.table_close = (tokens, idx, opts, env, self) =>
    `${defaultTableClose(tokens, idx, opts, env, self)}</div>`;

  // Open every link (explicit [..](..) and linkified bare URLs) in a NEW TAB so
  // clicking an external URL in a message doesn't navigate the
  // whole webui away and lose the session. rel=noopener stops the opened page
  // from reaching back via window.opener.
  const defaultLinkOpen = inst.renderer.rules.link_open ??
    ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));

  inst.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const token = tokens[idx]!;
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
    return defaultLinkOpen(tokens, idx, opts, env, self);
  };

  return inst;
}

export const md = build(false);
const mdUser = build(true);

// Assistant / system / compact-summary output — real markdown (soft breaks).
export function renderMarkdown(src: string): string {
  return md.render(src);
}

// User-typed prompts — single Enter renders as a line break (breaks: true).
export function renderUserMarkdown(src: string): string {
  return mdUser.render(src);
}
