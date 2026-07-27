import type { SkillEntry } from "@claude-webui/shared/api";

// Case-insensitive substring match against the command name. Prefix matches
// sort ahead of mid-string matches so "/bra" surfaces "brainstorming" near the
// top even when other names merely contain "bra".
export function filterSkills(items: SkillEntry[], query: string): SkillEntry[] {
  const q = query.toLowerCase();
  if (!q) return items.slice();
  const scored: Array<{ item: SkillEntry; rank: number }> = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    const idx = name.indexOf(q);
    if (idx === -1) continue;
    // Rank 0 = name starts with query, 1 = tail starts with query, 2 = other.
    const tail = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
    const rank = name.startsWith(q) ? 0 : tail.startsWith(q) ? 1 : 2;
    scored.push({ item, rank });
  }
  scored.sort((a, b) => a.rank - b.rank);
  return scored.map((s) => s.item);
}
