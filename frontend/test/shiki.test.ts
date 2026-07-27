import { afterEach, describe, expect, it, vi } from "vitest";
import { highlightToHtml } from "../src/render/shiki.js";
import { observeCodeFences } from "../src/render/code-fence-mounting.js";

class ImmediateIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    void this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
  root = null;
  rootMargin = "";
  thresholds = [0];
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Shiki code fences", () => {
  it("falls back to escaped plain text for an arbitrary fence label", async () => {
    const html = await highlightToHtml("<unsafe>", "definitely-not-a-language", false);
    expect(html).toContain("unsafe");
    expect(html).not.toContain("<unsafe>");
  });

  it("preserves language metadata so highlighted blocks follow theme changes", async () => {
    vi.stubGlobal("IntersectionObserver", ImmediateIntersectionObserver);
    document.body.innerHTML = '<div id="root"><pre><code class="language-js">const answer = 42</code></pre></div>';
    const root = document.querySelector<HTMLElement>("#root")!;

    observeCodeFences(root, { dark: false });
    await vi.waitFor(() => expect(root.querySelector("pre")?.dataset.cwTheme).toBe("light"));
    expect(root.querySelector("pre")?.dataset.cwLanguage).toBe("js");

    observeCodeFences(root, { dark: true });
    await vi.waitFor(() => expect(root.querySelector("pre")?.dataset.cwTheme).toBe("dark"));
    expect(root.textContent).toContain("const answer = 42");
  });
});
