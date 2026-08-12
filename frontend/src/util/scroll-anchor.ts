export interface ViewportAnchorPoint {
  key: string;
  offsetTop: number;
}

export interface ViewportAnchorSnapshot {
  points: ViewportAnchorPoint[];
  scrollTopFromEnd: number;
}

export type ViewportAnchorRestore = "row" | "distance";

export interface BottomLockObservation {
  atBottom: boolean;
  pinActive: boolean;
  userScrollIntent: boolean;
}

const ANCHOR_SELECTOR = "[data-scroll-key]";
const MAX_ANCHOR_POINTS = 8;

/**
 * Keep following the live tail across programmatic/layout scroll events.
 * Moving away from the bottom only changes that preference when a preceding
 * touch/wheel gesture proves it was the user, not a late history append.
 */
export function resolveBottomLock(
  currentlyLocked: boolean,
  observation: BottomLockObservation,
): boolean {
  if (observation.pinActive || observation.atBottom) return true;
  if (observation.userScrollIntent) return false;
  return currentlyLocked;
}

function anchorRows(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR));
}

/**
 * Remember several visible rows, rather than only one. A tool run at the
 * render-window boundary can merge with newly prepended calls and receive a
 * different Vue key; the next surviving visible row still gives us a stable
 * viewport reference.
 */
export function captureViewportAnchor(
  scroller: HTMLElement,
  root: HTMLElement,
): ViewportAnchorSnapshot {
  const viewport = scroller.getBoundingClientRect();
  const points: ViewportAnchorPoint[] = [];

  for (const row of anchorRows(root)) {
    const key = row.dataset.scrollKey;
    if (!key) continue;
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
    points.push({ key, offsetTop: rect.top - viewport.top });
    if (points.length >= MAX_ANCHOR_POINTS) break;
  }

  return {
    points,
    scrollTopFromEnd: scroller.scrollHeight - scroller.scrollTop,
  };
}

/**
 * Restore the first surviving visible row. If every captured row was replaced,
 * preserve the old distance from the end as a safe prepend fallback.
 */
export function restoreViewportAnchor(
  scroller: HTMLElement,
  root: HTMLElement,
  snapshot: ViewportAnchorSnapshot,
): ViewportAnchorRestore {
  const rows = anchorRows(root);
  const viewportTop = scroller.getBoundingClientRect().top;

  for (const point of snapshot.points) {
    const row = rows.find((candidate) => candidate.dataset.scrollKey === point.key);
    if (!row) continue;
    const currentOffset = row.getBoundingClientRect().top - viewportTop;
    const delta = currentOffset - point.offsetTop;
    if (Math.abs(delta) >= 0.5) scroller.scrollTop += delta;
    return "row";
  }

  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const desired = scroller.scrollHeight - snapshot.scrollTopFromEnd;
  scroller.scrollTop = Math.max(0, Math.min(maxTop, desired));
  return "distance";
}
