const DIRECTORY_BEHAVIOR_KEY = "agent-webui-local-directory-behavior-v1";

export type LocalDirectoryBehavior = "browse" | "open-on-host";

function hasFinePointer(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

export function localDirectoryBehavior(): LocalDirectoryBehavior {
  if (!hasFinePointer()) return "browse";
  try {
    const saved = localStorage.getItem(DIRECTORY_BEHAVIOR_KEY);
    if (saved === "browse" || saved === "open-on-host") return saved;
  } catch { /* storage can be disabled */ }
  // Fine-pointer clients use the desktop-native expectation for folder links:
  // open the host file manager. A user can still switch this browser to the
  // in-app directory browser; coarse-pointer/mobile clients always browse.
  return "open-on-host";
}

export function setLocalDirectoryBehavior(value: LocalDirectoryBehavior): void {
  try { localStorage.setItem(DIRECTORY_BEHAVIOR_KEY, value); } catch { /* storage can be disabled */ }
}

export function supportsHostDirectoryBehavior(): boolean {
  return hasFinePointer();
}
