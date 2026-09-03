import type { AgentKind } from "@agent-webui/shared";
import type { TitleEntry } from "./state.js";

export interface ResolvedSessionTitle {
  title: string | null;
  source: "auto" | "manual" | null;
  emoji?: string;
}

export function normalizeCanonicalTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim().slice(0, 120);
  return title || null;
}

const emojiPattern = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)/u;

function graphemes(value: string): string[] {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
    .map(part => part.segment);
}

export function normalizeTitleEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const segments = graphemes(normalized);
  if (segments.length !== 1 || !emojiPattern.test(segments[0] ?? "")) return null;
  return segments[0]!;
}

/** Split one trailing emoji grapheme from a canonical/display title. */
export function splitTitleEmoji(value: unknown): { title: string | null; emoji: string | null } {
  const normalized = normalizeCanonicalTitle(value);
  if (!normalized) return { title: null, emoji: null };
  const segments = graphemes(normalized);
  const emoji = normalizeTitleEmoji(segments.at(-1));
  if (!emoji) return { title: normalized, emoji: null };
  const title = normalizeCanonicalTitle(segments.slice(0, -1).join(""));
  return { title, emoji };
}

export function formatTitleWithEmoji(title: string, emoji?: string | null): string {
  const cleanTitle = splitTitleEmoji(title).title ?? "";
  const cleanEmoji = normalizeTitleEmoji(emoji);
  return cleanEmoji ? `${cleanTitle} ${cleanEmoji}`.trim() : cleanTitle;
}

/**
 * WebUI-local names are the titles this UI generated or the user chose, so
 * keep them stable when Codex exposes a different thread.name (which may be
 * derived directly from the opening user message). The shared Codex name is
 * only a fallback for threads that do not yet have a local title.
 */
export function resolveSessionTitle(
  agent: AgentKind,
  local: TitleEntry | undefined,
  canonicalCodexTitle: string | null | undefined,
): ResolvedSessionTitle {
  const localParts = splitTitleEmoji(local?.title);
  const localEmoji = normalizeTitleEmoji(local?.emoji) ?? localParts.emoji;
  if (localParts.title) {
    return {
      title: localParts.title,
      source: local?.source ?? "auto",
      ...(localEmoji ? { emoji: localEmoji } : {}),
    };
  }

  if (agent === "codex") {
    const canonical = splitTitleEmoji(canonicalCodexTitle);
    if (canonical.title) {
      const emoji = canonical.emoji ?? localEmoji;
      return {
        title: canonical.title,
        source: "auto",
        ...(emoji ? { emoji } : {}),
      };
    }
  }
  return { title: null, source: null };
}
