const NON_ASCII_RE = /[^\x00-\x7F]/;
const DIGIT_RE = /\d/;

export function contentSearchMinChars(query: string): number {
  return NON_ASCII_RE.test(query) || DIGIT_RE.test(query) ? 2 : 3;
}

export function shouldRunContentSearch(query: string): boolean {
  const trimmed = query.trim();
  return [...trimmed].length >= contentSearchMinChars(trimmed);
}
