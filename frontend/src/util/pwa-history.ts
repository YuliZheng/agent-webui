interface AgentHistoryState {
  agentWebUi: true;
  sessionId: string | null;
  layer?: string;
}

export interface PwaPopResult {
  handled: boolean;
  selection?: string | null;
}

let ignoreNextPop = false;

function standaloneMediaMatches(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(display-mode: standalone)").matches;
}

export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return standaloneMediaMatches() || navigatorWithStandalone.standalone === true;
}

function urlForSession(id: string | null): string {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("session", id);
  else url.searchParams.delete("session");
  return url.toString();
}

function stateFor(id: string | null, layer?: string): AgentHistoryState {
  return {
    agentWebUi: true,
    sessionId: id,
    ...(layer ? { layer } : {}),
  };
}

function parsedState(value: unknown): AgentHistoryState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<AgentHistoryState>;
  if (state.agentWebUi !== true) return null;
  if (state.sessionId !== null && typeof state.sessionId !== "string") return null;
  return state as AgentHistoryState;
}

export function initializeAppHistory(initialId: string | null): void {
  if (!isStandalonePwa()) {
    window.history.replaceState({ sessionId: initialId }, "", window.location.href);
    return;
  }

  // A direct session launch still needs a stable list level underneath it.
  // Replace the launch entry with home, then add exactly one conversation
  // entry. This gives Android's PWA back gesture the expected chat → list path.
  window.history.replaceState(stateFor(null), "", urlForSession(null));
  if (initialId) {
    window.history.pushState(stateFor(initialId), "", urlForSession(initialId));
  }
}

export function updateHistoryForSelection(
  id: string | null,
  previousId: string | null,
): void {
  if (!isStandalonePwa()) {
    window.history.pushState({ sessionId: id }, "", urlForSession(id));
    return;
  }

  if (id) {
    if (previousId) {
      // Session switching is one app level, not a chain of visited chats.
      window.history.replaceState(stateFor(id), "", urlForSession(id));
    } else {
      window.history.pushState(stateFor(id), "", urlForSession(id));
    }
    return;
  }

  if (!previousId) return;
  const current = parsedState(window.history.state);
  if (current?.sessionId === previousId && !current.layer) {
    ignoreNextPop = true;
    window.history.back();
  } else {
    window.history.replaceState(stateFor(null), "", urlForSession(null));
  }
}

export function setPwaLayerActive(
  layer: string,
  active: boolean,
  sessionId: string | null,
): void {
  if (!isStandalonePwa()) return;
  const current = parsedState(window.history.state);
  if (active) {
    if (current?.layer === layer) return;
    window.history.pushState(stateFor(sessionId, layer), "", urlForSession(sessionId));
    return;
  }
  if (current?.layer !== layer) return;
  ignoreNextPop = true;
  window.history.back();
}

export function handlePwaPopState(
  currentSessionId: string | null,
  targetState: unknown,
  closeTopLayer: () => boolean,
): PwaPopResult {
  if (!isStandalonePwa()) return { handled: false };
  if (ignoreNextPop) {
    ignoreNextPop = false;
    return { handled: true };
  }

  const target = parsedState(targetState);
  if (closeTopLayer()) {
    // A layer that did not create its own history entry consumed a back that
    // already reached the list. Recreate the current conversation level.
    if ((target?.sessionId ?? null) !== currentSessionId) {
      window.history.pushState(
        stateFor(currentSessionId),
        "",
        urlForSession(currentSessionId),
      );
    }
    return { handled: true };
  }

  if (currentSessionId) {
    // Regardless of which older session happens to be in browser history, one
    // PWA back from a conversation always means "return to chat list".
    if (target?.sessionId !== null) {
      window.history.replaceState(stateFor(null), "", urlForSession(null));
    }
    return { handled: true, selection: null };
  }

  // Never resurrect an older conversation while the PWA is already at home.
  // With no earlier entry Chrome closes/minimizes the standalone app itself.
  if (target?.sessionId) {
    window.history.replaceState(stateFor(null), "", urlForSession(null));
    return { handled: true, selection: null };
  }
  return { handled: true };
}
