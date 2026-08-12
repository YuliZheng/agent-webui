const FRONTEND_ENTRY_RE = /\bsrc=["']([^"']*\/assets\/index-[A-Za-z0-9_-]+\.js)["']/i;
const UPDATE_CHECK_MIN_GAP_MS = 30_000;
const SAFE_RELOAD_GRACE_MS = 750;
const SAFE_RELOAD_RETRY_MS = 1_000;

export function frontendEntryFromHtml(html: string): string | null {
  const value = FRONTEND_ENTRY_RE.exec(html)?.[1];
  if (!value) return null;
  try {
    return new URL(value, window.location.origin).pathname;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? null;
  }
}

export function currentFrontendEntry(): string | null {
  for (const script of Array.from(document.scripts)) {
    const src = script.getAttribute("src");
    if (!src || !/\/assets\/index-[A-Za-z0-9_-]+\.js(?:[?#]|$)/i.test(src)) continue;
    try {
      return new URL(src, window.location.href).pathname;
    } catch {
      return src.split(/[?#]/, 1)[0] ?? null;
    }
  }
  return null;
}

interface FrontendUpdateCoordinatorOptions {
  canReload: () => boolean;
  currentEntry?: () => string | null;
  fetchLatestHtml?: () => Promise<string>;
  reload?: () => void;
  reloadGraceMs?: number;
  reloadRetryMs?: number;
}

export interface FrontendUpdateCoordinator {
  check(): Promise<boolean>;
  dispose(): void;
}

async function fetchLatestShellHtml(): Promise<string> {
  // A programmatic GET is not a navigation, so the service worker takes its
  // network-first shell path and refreshes the cached `/` response before a
  // reload. This avoids the old-shell race on a slow Tailscale/relay link.
  const response = await fetch("/", {
    cache: "no-store",
    credentials: "include",
    headers: { Accept: "text/html" },
  });
  if (!response.ok) throw new Error(`frontend update check failed: ${response.status}`);
  return response.text();
}

export function createFrontendUpdateCoordinator(
  options: FrontendUpdateCoordinatorOptions,
): FrontendUpdateCoordinator {
  const getCurrentEntry = options.currentEntry ?? currentFrontendEntry;
  const fetchLatestHtml = options.fetchLatestHtml ?? fetchLatestShellHtml;
  const reload = options.reload ?? (() => window.location.reload());
  const reloadGraceMs = options.reloadGraceMs ?? SAFE_RELOAD_GRACE_MS;
  const reloadRetryMs = options.reloadRetryMs ?? SAFE_RELOAD_RETRY_MS;
  let checkWork: Promise<boolean> | null = null;
  let reloadPending = false;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const scheduleReload = (delay: number) => {
    if (disposed || reloadTimer) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (disposed || !reloadPending) return;
      if (!options.canReload()) {
        scheduleReload(reloadRetryMs);
        return;
      }
      reloadPending = false;
      reload();
    }, delay);
  };

  const check = (): Promise<boolean> => {
    if (checkWork) return checkWork;
    let work!: Promise<boolean>;
    work = (async () => {
      const current = getCurrentEntry();
      const latest = frontendEntryFromHtml(await fetchLatestHtml());
      const changed = !!current && !!latest && current !== latest;
      if (changed) {
        reloadPending = true;
        scheduleReload(reloadGraceMs);
      }
      return changed;
    })().finally(() => {
      if (checkWork === work) checkWork = null;
    });
    checkWork = work;
    return work;
  };

  return {
    check,
    dispose() {
      disposed = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = null;
    },
  };
}

export function watchForFrontendUpdates(
  registration: ServiceWorkerRegistration,
  canReload: () => boolean,
): () => void {
  const coordinator = createFrontendUpdateCoordinator({ canReload });
  let lastCheckAt = 0;

  const check = (force = false) => {
    if (document.visibilityState === "hidden") return;
    const now = Date.now();
    if (!force && now - lastCheckAt < UPDATE_CHECK_MIN_GAP_MS) return;
    lastCheckAt = now;
    void registration.update().catch((error: unknown) => {
      console.warn("Agent WebUI service worker update check failed", error);
    });
    void coordinator.check().catch((error: unknown) => {
      console.warn("Agent WebUI frontend update check failed", error);
    });
  };

  const onVisible = () => {
    if (document.visibilityState === "visible") check();
  };
  const onControllerChange = () => check(true);
  const onFocus = () => check();
  const onPageShow = () => check();
  const onOnline = () => check(true);

  navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onFocus);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("online", onOnline);
  check(true);

  return () => {
    coordinator.dispose();
    navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", onOnline);
  };
}
