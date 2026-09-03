export type SourceIndexReader<T> = (item: T) => number | null;

/** Resolve the oldest row to render without letting later appends move it. */
export function anchoredRenderStart<T>(
  items: readonly T[],
  floorSourceIndex: number | null,
  limit: number,
  sourceIndexOf: SourceIndexReader<T>,
): number {
  if (floorSourceIndex !== null) {
    const anchored = items.findIndex((item) => {
      const sourceIndex = sourceIndexOf(item);
      return sourceIndex !== null && sourceIndex >= floorSourceIndex;
    });
    if (anchored >= 0) return anchored;
  }
  return Math.max(0, items.length - Math.max(0, limit));
}

/** Find a durable physical source index at, or nearest to, a render boundary. */
export function sourceIndexNear<T>(
  items: readonly T[],
  start: number,
  sourceIndexOf: SourceIndexReader<T>,
): number | null {
  for (let i = Math.max(0, start); i < items.length; i++) {
    const sourceIndex = sourceIndexOf(items[i]!);
    if (sourceIndex !== null) return sourceIndex;
  }
  for (let i = Math.min(start - 1, items.length - 1); i >= 0; i--) {
    const sourceIndex = sourceIndexOf(items[i]!);
    if (sourceIndex !== null) return sourceIndex;
  }
  return null;
}
