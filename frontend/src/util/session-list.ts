import type { SessionListItem } from "@/types";

export type GestureAxis = "x" | "y" | null;
export function lockGestureAxis(dx: number, dy: number, threshold = 8): GestureAxis {
  if (Math.hypot(dx, dy) < threshold) return null;
  if (Math.abs(dx) >= 2 * Math.abs(dy)) return "x";
  return "y";
}

export function shouldRefreshPull(startedAtTop: boolean, dx: number, dy: number, threshold = 64): boolean {
  return startedAtTop && dy >= threshold && Math.abs(dy) >= 2 * Math.abs(dx);
}

export function sortPinnedByActivity<T extends SessionListItem>(items: readonly T[], isActive: (id: string) => boolean, effectiveTime: (item: T) => number): T[] {
  return [...items].sort((a, b) => Number(isActive(b.id)) - Number(isActive(a.id)) || effectiveTime(b) - effectiveTime(a));
}

export function reconcileSelectedIds(selected: readonly string[], existing: readonly string[]): string[] {
  const allowed = new Set(existing); return selected.filter((id) => allowed.has(id));
}

export function isSessionUnread(item: SessionListItem, watermark: string | undefined, selectedId: string | null, effectiveTime: number): boolean {
  if (item.id === selectedId) return false;
  const seen = new Date(watermark ?? item.readAt ?? 0).getTime();
  return effectiveTime > (Number.isFinite(seen) ? seen : 0);
}
