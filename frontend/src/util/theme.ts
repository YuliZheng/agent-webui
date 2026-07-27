import { ref, onUnmounted } from "vue";
import type { ThemeMode } from "../stores/ui.js";

/**
 * auto  → remove both classes; CSS @media handles dark/light natively
 * dark  → add .dark  (forces dark regardless of system)
 * light → add .light (suppresses the media-query dark path)
 */
export function applyTheme(mode: ThemeMode): void {
    const cl = document.documentElement.classList;
    cl.toggle("dark", mode === "dark");
    cl.toggle("light", mode === "light");
    syncThemeColor();
}

/**
 * Mirror the active header background into <meta name="theme-color"> so the
 * installed-PWA window titlebar (Chrome reads this tag) tracks the page exactly.
 * Reads the computed --cw-header-bg, which is already defined for every skin ×
 * dark/light/auto combination in tailwind.css, so this needs no per-skin table
 * and picks up future skins for free. Call after any change to the <html>
 * theme/style classes (or on OS theme change in auto mode).
 */
export function syncThemeColor(): void {
    if (typeof document === "undefined") return;
    const bg = getComputedStyle(document.documentElement)
    .getPropertyValue("--cw-header-bg")
    .trim();
    if (!bg) return;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
    }
    meta.content = bg;
}

const osDarkMq = matchMedia("(prefers-color-scheme: dark)");
// Auto mode follows the OS; keep the titlebar in sync when the system flips.
osDarkMq.addEventListener("change", syncThemeColor);

/** Mirrors the CSS variant logic: .dark class OR (system dark AND no .light class). */
export function isDark(): boolean {
  const cl = document.documentElement.classList;
  if (cl.contains("dark")) return true;
  if (cl.contains("light")) return false;
  return osDarkMq.matches;
}

/**
 * Reactive ref that tracks effective dark state.
 * Responds to OS theme changes (for auto mode) via matchMedia listener.
 * Call inside setup(); cleans up the listener on unmount.
 */
export function useDark() {
    const dark = ref(isDark());
    const update = () => { dark.value = isDark(); };
    osDarkMq.addEventListener("change", update);
    onUnmounted(() => osDarkMq.removeEventListener("change", update));
    return dark;
}
