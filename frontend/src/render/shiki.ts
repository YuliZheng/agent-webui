import type { BundledLanguage, Highlighter, SpecialLanguage } from "shiki";

// Languages preloaded when the highlighter is first instantiated. Anything
// outside this list lazy-loads on first encounter via loadLanguage() — a
// brief delay on that single render, then cached for the rest of the
// session. Pruned to the user's day-to-day mix (Python, TS, shell, JSON,
// markdown) to avoid eagerly fetching ~100 KB of grammars they may never
// need (cpp/java/css/html/etc.). Add a language back here if you find
// yourself frequently waiting on the lazy-load lag for it.
const BUNDLED: BundledLanguage[] = [
  "js", "ts", "py", "sh", "bash", "json", "yaml", "md",
];

let hlPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!hlPromise) {
    // Keep the sizeable highlighter runtime out of the initial application
    // chunk. It is fetched only when a fenced block approaches the viewport.
    hlPromise = import("shiki").then(({ createHighlighter }) => createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: BUNDLED,
    }));
  }
  return hlPromise;
}

export async function highlightToHtml(code: string, lang: string, dark: boolean): Promise<string> {
  const hl = await getHighlighter();
  let resolved: BundledLanguage | SpecialLanguage = "text";
  if (lang) {
    const loaded = hl.getLoadedLanguages() as string[];
    if (loaded.includes(lang)) {
      resolved = lang as BundledLanguage;
    } else {
      try {
        await hl.loadLanguage(lang as BundledLanguage);
        resolved = lang as BundledLanguage;
      } catch {
        // Markdown permits arbitrary fence labels. Shiki throws for an unknown
        // grammar, so deliberately render those blocks as escaped plain text.
      }
    }
  }
  return hl.codeToHtml(code, {
    lang: resolved,
    theme: dark ? "github-dark" : "github-light",
  });
}
