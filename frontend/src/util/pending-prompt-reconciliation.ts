import {
  codexVisibleMessageFromJson,
  codexVisibleMessagePriority,
  isCodexInjectedContextText,
  sameCodexVisibleMessage,
  type CodexVisibleMessage,
} from "@agent-webui/shared/codex";

const ATTACH_TRAILERS = [
  "\n\nAttached files (read with the Read tool to view):",
  // Pre-PDF wording — still present in historical session jsonls.
  "\n\nAttached image files (read with the Read tool to view):",
];

export interface PendingPromptCandidate {
  id: string;
  text: string;
  startedAtLineCount: number;
  startedAt?: number;
  startedAtSessionSize?: number;
  phase?: "sending" | "dispatched" | "accepted";
  steered?: boolean;
}

export interface SidebarPendingState {
  backendPreview: string | null;
  now: number;
  sessionSize: number;
}

const LEGACY_ACCEPTED_GRACE_MS = 15_000;

/**
 * Returns the newest optimistic prompt that should still override the
 * sidebar's durable backend preview.
 *
 * MessageList normally reconciles these entries, but unopened sessions never
 * mount it. An accepted prompt could therefore remain in localStorage forever
 * and cover a newer assistant reply. New entries carry their send-time file
 * size; legacy entries get a short grace period before an idle session's
 * durable preview wins.
 */
export function latestSidebarPendingPrompt(
  entries: readonly PendingPromptCandidate[],
  state: SidebarPendingState,
): PendingPromptCandidate | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry?.text) continue;
    if (entry.phase !== "accepted" || !state.backendPreview) return entry;

    if (typeof entry.startedAtSessionSize === "number") {
      if (state.sessionSize <= entry.startedAtSessionSize) return entry;
      continue;
    }

    const startedAt = typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt)
      ? entry.startedAt
      : 0;
    if (startedAt > 0 && state.now - startedAt < LEGACY_ACCEPTED_GRACE_MS) return entry;
  }
  return undefined;
}

export interface PendingPromptProbeRange {
  from: number;
  to: number;
}

interface CodexUserLanding {
  index: number;
  lastSourceIndex: number;
  text: string;
  clientId: string | null;
  used: boolean;
  message: CodexVisibleMessage;
}

export function normalizePendingUserText(text: string): string {
  for (const trailer of ATTACH_TRAILERS) {
    const index = text.indexOf(trailer);
    if (index >= 0) return text.slice(0, index).trim();
  }
  return text.trim();
}

function collectCodexUserLandings(raw: readonly string[]): CodexUserLanding[] {
  const result: CodexUserLanding[] = [];
  for (let index = 0; index < raw.length; index++) {
    const line = raw[index];
    if (!line) continue;
    const message = codexVisibleMessageFromJson(line);
    if (!message || message.role !== "user" || isCodexInjectedContextText(message.text)) continue;
    const previous = result.at(-1);
    if (
      previous
      && index - previous.lastSourceIndex <= 4
      && previous.message.transport !== message.transport
      && sameCodexVisibleMessage(previous.message, message)
    ) {
      previous.lastSourceIndex = index;
      previous.clientId ??= message.clientId ?? null;
      if (codexVisibleMessagePriority(message) > codexVisibleMessagePriority(previous.message)) {
        previous.message = message;
        previous.text = normalizePendingUserText(message.text);
      }
      continue;
    }
    result.push({
      index,
      lastSourceIndex: index,
      text: normalizePendingUserText(message.text),
      clientId: message.clientId ?? null,
      used: false,
      message,
    });
  }
  return result;
}

export function isCodexDurableUserMessage(raw: string | undefined): boolean {
  if (!raw) return false;
  const message = codexVisibleMessageFromJson(raw);
  return Boolean(
    message
    && message.role === "user"
    && !isCodexInjectedContextText(message.text),
  );
}

/**
 * Returns a small absolute source range around a pending prompt's send
 * boundary when that boundary has fallen outside the currently loaded tail.
 * Four lines of look-behind cover the response_item/event_msg companion pair
 * plus a cursor that raced one line ahead; the forward allowance covers small
 * transport records without expanding the normal 200-line session tail.
 */
export function pendingPromptProbeRange(
  entry: PendingPromptCandidate,
  firstLoadedIndex: number,
): PendingPromptProbeRange | null {
  const boundary = Math.max(0, Math.floor(entry.startedAtLineCount));
  const firstLoaded = Math.max(0, Math.floor(firstLoadedIndex));
  if (firstLoaded === 0 || boundary >= firstLoaded) return null;
  const from = Math.max(0, boundary - 4);
  const to = Math.min(firstLoaded, boundary + 32);
  return to > from ? { from, to } : null;
}

/**
 * Returns optimistic prompt ids whose durable Codex user-message record has
 * arrived, across response, legacy-event, and item_completed transports.
 *
 * New Codex records echo the WebUI's optimistic id as `client_id`. That is the
 * authoritative reconciliation key and deliberately does not depend on the
 * send-time source cursor: a cursor/liveness update can race slightly ahead of
 * the reactive line cache. Text + source-boundary matching remains as a
 * compatibility fallback for older records that do not carry `client_id`.
 */
export function matchedCodexPendingPromptIds(
  raw: readonly string[],
  entries: readonly PendingPromptCandidate[],
): string[] {
  const landed = collectCodexUserLandings(raw);
  const matched: string[] = [];

  for (const entry of entries) {
    const byClientId = landed.find((record) =>
      !record.used && record.clientId === entry.id
    );
    if (byClientId) {
      byClientId.used = true;
      matched.push(entry.id);
      continue;
    }

    const normalized = normalizePendingUserText(entry.text);
    // Oldest-first consumption means N identical sends still require N
    // durable records when no unique client id is available.
    const exact = landed.find((record) =>
      !record.used &&
      record.index >= entry.startedAtLineCount &&
      record.text === normalized
    );
    if (exact) {
      exact.used = true;
      matched.push(entry.id);
      continue;
    }

    // When interrupted steers are resent as one joined turn, several
    // optimistic entries can legitimately be contained in one user record.
    if (normalized.length > 0 && landed.some((record) =>
      record.index >= entry.startedAtLineCount &&
      record.text !== normalized &&
      record.text.includes(normalized)
    )) {
      matched.push(entry.id);
      continue;
    }

    // A non-steered, accepted turn must have become durable before any later
    // user turn could land. If newer user records exist but neither its unique
    // id nor its text appears, this entry was migrated from an unrelated draft
    // by the historical cwd-based promotion race. Steered prompts are excluded:
    // Codex intentionally does not echo those and the local bubble is their
    // only durable representation.
    if (
      entry.phase === "accepted" &&
      entry.steered !== true &&
      landed.some((record) => record.index >= entry.startedAtLineCount)
    ) {
      matched.push(entry.id);
    }
  }

  return matched;
}
