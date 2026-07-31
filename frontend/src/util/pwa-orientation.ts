import { isStandalonePwa } from "./pwa-history.js";

export const PWA_ORIENTATION = "portrait-primary" as const;
const PWA_ORIENTATION_FALLBACK = "portrait" as const;
type PwaOrientationLock = typeof PWA_ORIENTATION | typeof PWA_ORIENTATION_FALLBACK;

export interface OrientationLockTarget {
  lock(orientation: PwaOrientationLock): Promise<void>;
}

function currentOrientationLockTarget(): OrientationLockTarget | undefined {
  if (typeof screen === "undefined") return undefined;
  const orientation = screen.orientation as ScreenOrientation & Partial<OrientationLockTarget>;
  return typeof orientation?.lock === "function"
    ? orientation as OrientationLockTarget
    : undefined;
}

/**
 * Reinforce the manifest orientation while an installed PWA is running.
 * Unsupported browsers (notably iOS versions without the Screen Orientation
 * API) simply fall back to the manifest declaration.
 */
export async function lockStandalonePwaOrientation(
  standalone = isStandalonePwa(),
  orientation = currentOrientationLockTarget(),
): Promise<boolean> {
  if (!standalone || !orientation) return false;
  try {
    await orientation.lock(PWA_ORIENTATION);
    return true;
  } catch {
    // Some Android WebView/Chrome versions reject the more specific value but
    // accept the broader portrait lock.
    try {
      await orientation.lock(PWA_ORIENTATION_FALLBACK);
      return true;
    } catch {
      // Orientation locking is best-effort and may be denied by the platform.
      return false;
    }
  }
}

/**
 * Android can reject an orientation request made before the standalone window
 * is fully active, and may release it while the app is backgrounded. Reapply
 * after load, page restoration, foregrounding, and a platform orientation
 * change so an already-installed WebAPK does not have to wait for its manifest
 * update cycle.
 */
export function initStandalonePwaOrientationLock(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const relock = () => {
    if (document.visibilityState !== "hidden") {
      void lockStandalonePwaOrientation();
    }
  };

  if (document.readyState === "complete") relock();
  else window.addEventListener("load", relock, { once: true });

  window.addEventListener("pageshow", relock);
  document.addEventListener("visibilitychange", relock);
  screen.orientation?.addEventListener?.("change", relock);
}
