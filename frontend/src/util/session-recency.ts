import type { SessionListItem } from "@claude-webui/shared/api";

function finiteMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function baseActivity(item: SessionListItem | null | undefined): {
  iso: string;
  ms: number;
} {
  const iso = item?.lastTurnAt || item?.mtime || "";
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return { iso, ms: finiteMs(parsed) };
}

export function effectiveSessionActivityMs(
  item: SessionListItem | null | undefined,
  draftEditedAt = 0,
  pendingPromptStartedAt = 0,
): number {
  const base = baseActivity(item);
  return Math.max(
    base.ms,
    finiteMs(draftEditedAt),
    finiteMs(pendingPromptStartedAt),
  );
}

export function effectiveSessionActivityIso(
  item: SessionListItem | null | undefined,
  draftEditedAt = 0,
  pendingPromptStartedAt = 0,
): string {
  const base = baseActivity(item);
  const effective = effectiveSessionActivityMs(
    item,
    draftEditedAt,
    pendingPromptStartedAt,
  );
  return effective > base.ms ? new Date(effective).toISOString() : base.iso;
}
