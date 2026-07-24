import { createHighlighter, type Highlighter } from "shiki";

const LIGHT_THEME = "github-light";
const DARK_THEME = "github-dark";
const COMMON_LANGUAGES = [
  "text",
  "plaintext",
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "json",
  "bash",
  "shell",
  "powershell",
  "python",
  "html",
  "css",
  "vue",
  "markdown",
  "yaml",
  "sql",
  "diff",
] as const;

let highlighterPromise: Promise<Highlighter> | null = null;
let intersectionObserver: IntersectionObserver | null = null;
const observed = new WeakSet<HTMLElement>();

function highlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: [LIGHT_THEME, DARK_THEME],
    langs: [...COMMON_LANGUAGES],
  });
  return highlighterPromise;
}

function languageFor(code: HTMLElement): string {
  const className = [...code.classList].find((name) => name.startsWith("language-"));
  return className?.slice("language-".length).trim() || "text";
}

function copyText(pre: HTMLElement): string {
  return pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  if (!ok) throw new Error("Copy failed");
}

export function ensureCopyButton(pre: HTMLElement): HTMLButtonElement {
  let wrapper = pre.parentElement;
  if (!wrapper?.classList.contains("cw-code-wrap")) {
    wrapper = document.createElement("div");
    wrapper.className = "cw-code-wrap";
    pre.before(wrapper);
    wrapper.append(pre);
  }
  const existing = wrapper.querySelector<HTMLButtonElement>(":scope > .cw-copy-btn");
  if (existing) return existing;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "cw-copy-btn";
  button.textContent = "Copy";
  button.setAttribute("aria-label", "Copy code");
  button.addEventListener("click", async () => {
    try {
      await writeClipboard(copyText(wrapper!.querySelector<HTMLElement>("pre")!));
      button.dataset.state = "ok";
      button.textContent = "✓";
    } catch {
      button.dataset.state = "err";
      button.textContent = "!";
    }
    window.setTimeout(() => {
      button.removeAttribute("data-state");
      button.textContent = "Copy";
    }, 1_500);
  });
  wrapper.append(button);
  return button;
}

async function highlight(pre: HTMLElement): Promise<void> {
  if (pre.dataset.cwCodeState === "ready" || pre.dataset.cwCodeState === "loading") return;
  const code = pre.querySelector<HTMLElement>("code");
  if (!code) return;
  pre.dataset.cwCodeState = "loading";
  const source = code.textContent ?? "";
  const requestedLanguage = languageFor(code);
  try {
    const engine = await highlighter();
    const loaded = new Set(engine.getLoadedLanguages());
    const lang = loaded.has(requestedLanguage) ? requestedLanguage : "text";
    const rendered = engine.codeToHtml(source, {
      lang,
      themes: {
        light: LIGHT_THEME,
        dark: DARK_THEME,
      },
      defaultColor: false,
    });
    const template = document.createElement("template");
    template.innerHTML = rendered.trim();
    const replacement = template.content.firstElementChild as HTMLElement | null;
    if (!replacement) throw new Error("Shiki returned no code block");
    replacement.dataset.cwCodeState = "ready";
    pre.replaceWith(replacement);
    ensureCopyButton(replacement);
  } catch {
    pre.dataset.cwCodeState = "ready";
  }
}

function observer(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  intersectionObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const pre = entry.target as HTMLElement;
      intersectionObserver?.unobserve(pre);
      void highlight(pre);
    }
  }, {
    rootMargin: "240px 0px",
  });
  return intersectionObserver;
}

export function observeCodeFences(root: ParentNode): void {
  for (const pre of root.querySelectorAll<HTMLElement>("pre")) {
    if (!pre.querySelector("code")) continue;
    ensureCopyButton(pre);
    if (observed.has(pre) || pre.dataset.cwCodeState === "ready") continue;
    observed.add(pre);
    const lazyObserver = observer();
    if (lazyObserver) lazyObserver.observe(pre);
    else void highlight(pre);
  }
}

export function stopObservingCodeFences(root: ParentNode): void {
  if (!intersectionObserver) return;
  for (const pre of root.querySelectorAll<HTMLElement>("pre")) {
    intersectionObserver.unobserve(pre);
  }
}
