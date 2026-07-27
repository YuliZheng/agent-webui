import { readonly, ref, type Ref } from "vue";

export type PwaInstallStatus =
  | "ready"
  | "prompting"
  | "installing"
  | "stalled"
  | "installed"
  | "unavailable"
  | "dismissed";

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
}

interface PwaInstallControllerOptions {
  target?: EventTarget | undefined;
  isStandalone?: () => boolean;
  stallAfterMs?: number;
}

export interface PwaInstallController {
  readonly status: Readonly<Ref<PwaInstallStatus>>;
  init(): void;
  requestInstall(): Promise<void>;
  dispose(): void;
}

// Chromium's WebAPK server request has historically used a 60-second timeout.
// Do not call a normal package-generation wait "stalled" before that window.
const DEFAULT_STALL_AFTER_MS = 60_000;

/**
 * Owns the one-shot browser install prompt. Keeping this outside component
 * lifecycle means the event can be captured before Settings is ever opened.
 */
export function createPwaInstallController(
  options: PwaInstallControllerOptions = {},
): PwaInstallController {
  const target = options.target;
  const stallAfterMs = options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
  const state = ref<PwaInstallStatus>(
    options.isStandalone?.() ? "installed" : "unavailable",
  );
  let initialized = false;
  let deferredPrompt: BeforeInstallPromptEvent | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  function clearStallTimer() {
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    }
  }

  function markInstalled() {
    deferredPrompt = null;
    clearStallTimer();
    state.value = "installed";
  }

  function capturePrompt(event: Event) {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    clearStallTimer();
    state.value = "ready";
  }

  function hasInstalled() {
    return state.value === "installed";
  }

  function init() {
    if (initialized || !target) return;
    initialized = true;
    target.addEventListener("beforeinstallprompt", capturePrompt);
    target.addEventListener("appinstalled", markInstalled);
  }

  async function requestInstall() {
    if (state.value !== "ready" || !deferredPrompt) return;

    const prompt = deferredPrompt;
    state.value = "prompting";
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      deferredPrompt = null;

      // Some browsers can emit appinstalled before userChoice settles.
      if (hasInstalled()) return;
      if (choice.outcome === "dismissed") {
        state.value = "dismissed";
        return;
      }

      state.value = "installing";
      stallTimer = setTimeout(() => {
        if (state.value === "installing") state.value = "stalled";
      }, stallAfterMs);
    } catch {
      deferredPrompt = null;
      state.value = "unavailable";
    }
  }

  function dispose() {
    if (initialized && target) {
      target.removeEventListener("beforeinstallprompt", capturePrompt);
      target.removeEventListener("appinstalled", markInstalled);
    }
    initialized = false;
    deferredPrompt = null;
    clearStallTimer();
  }

  return {
    status: readonly(state),
    init,
    requestInstall,
    dispose,
  };
}

function isRunningStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.("(display-mode: standalone)").matches === true
    || iosNavigator.standalone === true;
}

const pwaInstall = createPwaInstallController({
  target: typeof window === "undefined" ? undefined : window,
  isStandalone: isRunningStandalone,
});

export const pwaInstallStatus = pwaInstall.status;
export const initPwaInstall = pwaInstall.init;
export const requestPwaInstall = pwaInstall.requestInstall;
