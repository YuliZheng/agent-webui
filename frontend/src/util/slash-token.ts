export interface SlashToken {
  // Index in the full text where the "/" begins.
  start: number;
  // Characters typed after the "/", up to the caret.
  query: string;
}

const NAME_CHARS = /^[A-Za-z0-9:_-]*$/;

// Detect an active slash-command token immediately left of `caret`. Returns
// null when there is no such token. The token is the run of non-whitespace
// characters ending at the caret; it qualifies only when it starts with "/",
// has no second "/" (so filesystem paths like /home/sys don't match), and the
// chars after "/" are all skill-name characters.
export function findSlashToken(text: string, caret: number): SlashToken | null {
  const c = Math.max(0, Math.min(caret, text.length));
  let start = c;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  const token = text.slice(start, c);
  if (token[0] !== "/") return null;
  const body = token.slice(1);
  if (body.includes("/")) return null;
  if (!NAME_CHARS.test(body)) return null;
  return { start, query: body };
}
