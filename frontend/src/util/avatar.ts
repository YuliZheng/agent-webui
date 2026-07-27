// IM-style row avatar helpers — colored gradient + 1 char glyph.
//
// Color strategy: the COLOR comes from a hash of the cwd into a curated
// palette, so every session in the same dir (forks included, since forks
// inherit cwd) shares a color and visually clusters. The palette is used
// instead of a raw `hash % 360` hue because plain modulo let two unrelated
// cwds land within ~10-15° of each other — different, but indistinguishable
// at a glance. A fixed set of well-separated, hand-tuned colors guarantees
// distinct dirs read as distinct (until the palette wraps, which repeats a
// color cleanly rather than producing a confusing near-match). LIGHTNESS
// varies subtly per session id so sibling sessions in the same dir aren't
// mistaken for the same row.
//
// Glyph: just one character. The user has already seen the cwd in the
// row's title or group header; the avatar's job is recognition, not
// re-stating context. Two-letter initials add noise without meaning.

// [hue, saturation, lightness] anchors spread EVENLY around the wheel
// (~30° apart) so no two are closer than they need to be — hand-clustered
// palettes kept crowding the warm and cool regions, making distinct cwds
// look alike. Muted "designer" tuning (Linear/Notion vibe): lower saturation
// (32–58%) reads calmer and more refined than full-vivid while staying
// distinguishable, with one desaturated slate-gray as a neutral standout.
// White glyph text / emoji stay legible at these lightnesses.
// Categorical "tell-them-apart-at-a-glance" set (Tableau-style): only ONE
// purple, and every entry differs in saturation/lightness as well as hue so
// adjacent ones never read alike. Muted enough to stay refined on dark bg.
const PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [2, 62, 53],    // red
  [30, 70, 52],   // orange
  [46, 62, 49],   // gold
  [96, 46, 46],   // lime
  [135, 42, 43],  // green
  [180, 44, 44],  // teal
  [212, 52, 53],  // blue
  [286, 40, 56],  // purple (the only one)
  [334, 56, 60],  // pink
  [22, 36, 39],   // brown (low-sat dark warm — a distinct category)
  [220, 12, 52],  // slate (neutral standout, reserved for scratch)
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// The neutral slate is the last palette entry. It's RESERVED for scratch /
// throwaway dirs so they read as deliberately unobtrusive — and so seeing
// gray unambiguously means "scratch". Real project dirs are assigned only
// from the vivid range below, never gray.
const SLATE_INDEX = PALETTE.length - 1;
const VIVID_COUNT = PALETTE.length - 1; // 0..VIVID_COUNT-1 are the colors

// Throwaway scratch dirs that should always get the inconspicuous slate.
// Matches /tmp/*scratch* (covers /tmp/<user>-scratch, /tmp/claude-webui-
// scratch, etc.) — scratch lives under /tmp by convention.
function isInconspicuousCwd(cwd: string): boolean {
  return /^\/tmp\/.*scratch/.test(cwd);
}

// Build a cwd → palette-index assignment that GUARANTEES the most recently
// active distinct directories don't share a color. `orderedCwds` must be in
// recency order (most-recent first; duplicates allowed — same dir resolves
// to one entry). Each distinct cwd prefers its natural hash color; if that
// slot is already taken by an earlier (more recent) distinct cwd, it probes
// forward to the next free palette slot. Only once all PALETTE.length colors
// are in use do later (older) dirs unavoidably repeat — by then the recent
// ones the user cares about are already collision-free. Same cwd → same
// color (clustering preserved); deterministic given the same ordering.
export function assignCwdColors(orderedCwds: Array<string | null | undefined>): Map<string, number> {
  const map = new Map<string, number>();
  const used = new Set<number>();
  for (const raw of orderedCwds) {
    const cwd = raw || "";
    if (!cwd || map.has(cwd)) continue;
    // Scratch dirs always take the reserved slate; they don't consume a
    // vivid slot or participate in vivid deconfliction.
    if (isInconspicuousCwd(cwd)) { map.set(cwd, SLATE_INDEX); continue; }
    let idx = hashString(cwd) % VIVID_COUNT;
    if (used.size < VIVID_COUNT) {
      let probes = 0;
      while (used.has(idx) && probes < VIVID_COUNT) { idx = (idx + 1) % VIVID_COUNT; probes++; }
    }
    map.set(cwd, idx);
    used.add(idx);
  }
  return map;
}

// Render a gradient for a resolved palette index, with a subtle per-session
// lightness nudge (±3) so same-dir siblings (which share the index) still
// read as distinct rows without drifting into a neighbor's brightness band.
export function gradientForIndex(index: number, id: string): string {
  const [hue, sat, baseL] = PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length]!;
  const lightness = baseL - 3 + (hashString(id) % 7);
  const top = `hsl(${hue}, ${sat}%, ${lightness}%)`;
  const bottom = `hsl(${hue}, ${Math.min(100, sat + 5)}%, ${lightness - 12}%)`;
  return `linear-gradient(135deg, ${top} 0%, ${bottom} 100%)`;
}

// Flat anchor color for a palette index (no gradient, no per-id nudge).
// Used to tint the row's cwd path text so it visually links to the avatar.
export function paletteColor(index: number): string {
  const [hue, sat, l] = PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length]!;
  return `hsl(${hue}, ${sat}%, ${l}%)`;
}

// Standalone fallback for contexts without the recency-aware assignment
// (e.g. pending drafts not yet in the sessions list). Plain hash → index.
export function avatarGradient(opts: { cwd?: string | null; id: string }): string {
  const cwd = opts.cwd || "";
  if (cwd && isInconspicuousCwd(cwd)) return gradientForIndex(SLATE_INDEX, opts.id);
  const seed = cwd || opts.id;
  return gradientForIndex(hashString(seed) % VIVID_COUNT, opts.id);
}

// Single-char avatar glyph.
//   - Prefer title's first non-trivial char (CJK / Latin / etc).
//   - Fall back to cwd basename's first letter.
//   - Strips leading punctuation / digits / whitespace so "01_refit"
//     shows R, not 0. Uses Unicode property escapes (with the `u` flag)
//     so CJK letters in the title are preserved — the previous `\W`
//     pattern was ASCII-only and stripped Chinese chars too.
export function avatarText(opts: { title?: string | null; cwd?: string | null; id: string }): string {
  const title = (opts.title ?? "").trim();
  const fallback = (opts.cwd ?? "").split("/").filter(Boolean).pop() ?? opts.id;
  const src = title || fallback;
  const cleaned = src.replace(/^[\p{P}\p{N}\p{S}\s_]+/u, "");
  const ch = cleaned[0];
  if (!ch) return "?";
  return /[A-Za-z]/.test(ch) ? ch.toUpperCase() : ch;
}
