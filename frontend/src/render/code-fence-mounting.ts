import { highlightToHtml } from "./shiki.js";
import { copyText } from "../util/clipboard.js";

interface ObserveOpts { dark: boolean }

// Wrap a <pre> with a relative container + a "copy" button in the top-right
// corner. Safe to call multiple times: an already-wrapped pre is skipped.
// We wrap BEFORE Shiki's `pre.outerHTML = html` swap so the wrap survives the
// rewrite (only the inner pre is replaced; the wrapper stays put). The click
// handler re-reads `wrap.querySelector("pre")` each fire so it copies the
// post-highlight text, not a stale reference.
function ensureCopyButton(pre: HTMLElement): void {
  const parent = pre.parentElement;
  if (!parent) return;
  if (parent.classList.contains("cw-code-wrap")) return;
  const wrap = document.createElement("div");
  wrap.className = "cw-code-wrap";
  parent.insertBefore(wrap, pre);
  wrap.appendChild(pre);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cw-copy-btn";
  btn.title = "Copy code";
  btn.setAttribute("aria-label", "Copy code");
  btn.textContent = "Copy";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    e.preventDefault();
    const text = wrap.querySelector("pre")?.textContent ?? "";
    try {
      await copyText(text);
      btn.textContent = "Copied";
      btn.dataset.state = "ok";
    } catch {
      btn.textContent = "Failed";
      btn.dataset.state = "err";
    }
    setTimeout(() => {
      btn.textContent = "Copy";
      delete btn.dataset.state;
    }, 1500);
  });
  wrap.appendChild(btn);
}

export function observeCodeFences(root: HTMLElement, opts: ObserveOpts) {
  // Wrap every fenced block with a copy button — including the ones that
  // never get a language- class (plain ``` ``` blocks), which Shiki skips.
  root.querySelectorAll<HTMLElement>("pre").forEach(ensureCopyButton);

  // Shiki replaces the original <pre><code class="language-*"> tree. Persist
  // the language on the generated <pre> so a light/dark theme change can find
  // and re-render blocks that have already been highlighted.
  const blocks = root.querySelectorAll<HTMLElement>(
    "pre > code[class*=language-], pre[data-cw-language]",
  );
  if (!("IntersectionObserver" in window) || blocks.length === 0) return;
  const io = new IntersectionObserver(async (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const target = e.target as HTMLElement;
      io.unobserve(target);
      const pre = target.matches("pre") ? target : target.closest("pre");
      if (!pre) continue;
      const theme = opts.dark ? "dark" : "light";
      if (pre.dataset.cwTheme === theme) continue;
      const code = target.matches("code") ? target : pre.querySelector("code");
      const lang = pre.dataset.cwLanguage
        ?? (Array.from(code?.classList ?? []).find((c) => c.startsWith("language-")) ?? "language-text").slice(9);
      try {
        const html = await highlightToHtml(pre.textContent ?? "", lang, opts.dark);
        const container = pre.parentElement;
        pre.outerHTML = html;
        const replacement = container?.querySelector<HTMLElement>("pre");
        if (replacement) {
          replacement.dataset.cwLanguage = lang;
          replacement.dataset.cwTheme = theme;
        }
      } catch (error) {
        // Highlighting is progressive enhancement. Keep the original escaped
        // code block usable if a grammar chunk or highlighter initialization
        // fails, and avoid an unhandled IntersectionObserver rejection.
        console.warn("[code-highlight] failed", error);
      }
    }
  }, { rootMargin: "200px" });
  blocks.forEach((b) => io.observe(b));
}
