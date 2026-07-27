export interface InsertResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

// Splice `insertion` into `current` at the [selectionStart, selectionEnd) range,
// adding a leading space if the char to the left of the cursor is non-space and
// non-empty. Returns the new text and the cursor position right after the
// inserted text (selection collapsed).
export function insertAtCursor(
  current: string,
  selectionStart: number,
  selectionEnd: number,
  insertion: string,
): InsertResult {
  const start = Math.max(0, Math.min(selectionStart, current.length));
  const end = Math.max(start, Math.min(selectionEnd, current.length));
  const before = current.slice(0, start);
  const after = current.slice(end);
  const needsLeadingSpace =
    before.length > 0 && !/\s$/.test(before) && !/^\s/.test(insertion);
  const lead = needsLeadingSpace ? " " : "";
  const text = before + lead + insertion + after;
  const cursor = before.length + lead.length + insertion.length;
  return { text, selectionStart: cursor, selectionEnd: cursor };
}
