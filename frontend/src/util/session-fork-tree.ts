export interface OrderedSessionRow {
  id: string;
  depth: number;
}

interface OrderSessionForkRowsOptions {
  parentOf: (id: string) => string | null | undefined;
  /**
   * Sessions that may contribute ancestry even when they are rendered in a
   * different sidebar section (for example Active, Pinned, or a manual group).
   */
  hierarchyIds?: readonly string[];
}

/**
 * Keeps fork siblings together while preserving their real ancestry depth.
 * The render set and hierarchy set are intentionally separate: a running fork
 * remains visibly indented in Active even when its inactive parent is omitted
 * from that compact section.
 */
export function orderSessionForkRows(
  ids: readonly string[],
  options: OrderSessionForkRowsOptions,
): OrderedSessionRow[] {
  const orderedIds = [...new Set(ids)];
  const idSet = new Set(orderedIds);
  const hierarchySet = new Set(options.hierarchyIds ?? orderedIds);
  const position = new Map(orderedIds.map((id, index) => [id, index]));
  const childrenOf = new Map<string, string[]>();

  for (const id of orderedIds) {
    const parent = options.parentOf(id);
    if (!parent || parent === id || !idSet.has(parent)) continue;
    const children = childrenOf.get(parent) ?? [];
    children.push(id);
    childrenOf.set(parent, children);
  }

  const depthOf = (id: string): number => {
    let depth = 0;
    let current = id;
    const visited = new Set([id]);
    while (true) {
      const parent = options.parentOf(current);
      if (!parent || parent === current || !hierarchySet.has(parent)) return depth;
      if (visited.has(parent)) return 0;
      visited.add(parent);
      depth += 1;
      current = parent;
    }
  };

  const subtreePosition = new Map<string, number>();
  const computing = new Set<string>();
  const earliestSubtreePosition = (id: string): number => {
    const cached = subtreePosition.get(id);
    if (cached !== undefined) return cached;
    const ownPosition = position.get(id) ?? Number.MAX_SAFE_INTEGER;
    if (computing.has(id)) return ownPosition;
    computing.add(id);
    let earliest = ownPosition;
    for (const child of childrenOf.get(id) ?? []) {
      earliest = Math.min(earliest, earliestSubtreePosition(child));
    }
    computing.delete(id);
    subtreePosition.set(id, earliest);
    return earliest;
  };
  const sourceOrder = (left: string, right: string): number =>
    earliestSubtreePosition(left) - earliestSubtreePosition(right);

  const rows: OrderedSessionRow[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    rows.push({ id, depth: depthOf(id) });
    for (const child of [...(childrenOf.get(id) ?? [])].sort(sourceOrder)) {
      visit(child);
    }
  };

  const roots = orderedIds.filter((id) => {
    const parent = options.parentOf(id);
    return !parent || !idSet.has(parent);
  });
  for (const root of [...roots].sort(sourceOrder)) visit(root);
  // Surface cycle members once at depth zero instead of dropping the rows.
  for (const id of orderedIds) visit(id);
  return rows;
}
