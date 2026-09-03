export type SourceIndexReader<T> = (item: T) => number | null;

export interface AutoFillEarlierState {
  lockedToBottom: boolean;
  canLoadEarlier: boolean;
  loadInflight: boolean;
  hasLoadError: boolean;
  scrollHeight: number;
  clientHeight: number;
  overflowTolerance: number;
  batchesLoaded: number;
  maxBatches: number;
}

/** Accept only durable, non-negative physical record indexes from storage. */
export function parseStoredRenderFloor(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * A compact tail can be shorter than the viewport after tool calls collapse.
 * Pull a bounded amount of earlier context while the reader is still at the
 * live tail, but never compete with explicit loading or retry states.
 */
export function shouldAutoFillEarlier(state: AutoFillEarlierState): boolean {
  return state.lockedToBottom
    && state.canLoadEarlier
    && !state.loadInflight
    && !state.hasLoadError
    && state.clientHeight > 0
    && state.scrollHeight <= state.clientHeight + state.overflowTolerance
    && state.batchesLoaded < state.maxBatches;
}

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
