import {
  isUser, isAssistant, isSystem,
  isUserPromptShape, isUserToolResultShape,
  hasIsMeta, hasIsCompactSummary, hasIsApiErrorMessage,
  systemSubtype,
} from "@claude-webui/shared/discriminate";

export type BlockKind =
  | "UserPromptBlock"
  | "UserToolResultBlock"
  | "UserCompactSummaryBlock"
  | "TaskNotificationBlock"
  | "AssistantBlock"
  | "AssistantApiErrorBlock"
  | "TurnDurationBlock"
  | "AwaySummaryBlock"
  | "LocalCommandBlock"
  | "ApiErrorBlock"
  | "EmptyCompletionBlock"
  | "CompactBoundaryBlock";

function asLoose(rec: unknown): Record<string, unknown> | null | undefined {
  if (rec === null || rec === undefined) return rec;
  if (typeof rec === "object" && !Array.isArray(rec)) return rec as Record<string, unknown>;
  return null;
}

// "Continue from where you left off." injected as user/isMeta on every resume
// (and after fork-then-send), and the matching synthetic assistant ack
// "No response requested." produced by the same protocol step. They are pure
// resume artifacts the user never sees in the CLI; rendering them was making
// the chat look noisy on every turn. See docs/claude-stream-json-protocol.md
// "Continue from where you left off. injection on resume".
function isResumeArtifact(rec: Record<string, unknown> | null | undefined): boolean {
  if (!rec) return false;
  if (rec.isMeta === true) {
    const content = (rec.message as { content?: unknown } | undefined)?.content;
    const text = typeof content === "string" ? content : "";
    if (text.includes("Continue from where you left off")) return true;
  }
  if (rec.type === "assistant" && rec.isApiErrorMessage !== true) {
    const model = (rec.message as { model?: unknown } | undefined)?.model;
    if (model === "<synthetic>") return true;
  }
  return false;
}

// CLI synthesizes a 3-record user-shaped trio whenever it processes a TUI
// slash-command (e.g. `/model X`, triggered both by the user typing in TUI
// and by our set_model control_request which the CLI internally reframes
// as a slash command):
//   1. isMeta=true,  content="<local-command-caveat>...DO NOT respond..."
//   2.               content="<command-name>/X</command-name><command-args>...</command-args>"
//   3.               content="<local-command-stdout>...</local-command-stdout>" (or stderr)
//
// The caveat carries no user-meaningful info — drop it like a resume artifact.
// The other two render via LocalCommandBlock, which already knows how to
// parse `<command-*>` / `<local-command-*>` tags (used by system/local_command
// records). LocalCommandBlock reads `record.content` for the system shape;
// for the user-shape variant it falls back to `record.message.content`.
function isLocalCommandCaveat(rec: Record<string, unknown> | null | undefined): boolean {
  if (!rec || rec.type !== "user") return false;
  const content = (rec.message as { content?: unknown } | undefined)?.content;
  return typeof content === "string" && content.startsWith("<local-command-caveat>");
}
function isLocalCommandUserShape(rec: Record<string, unknown> | null | undefined): boolean {
  if (!rec || rec.type !== "user") return false;
  const content = (rec.message as { content?: unknown } | undefined)?.content;
  if (typeof content !== "string") return false;
  return (
    content.startsWith("<command-name>") ||
    content.startsWith("<local-command-stdout>") ||
    content.startsWith("<local-command-stderr>")
  );
}

// A manual `/compact` (or `/clear`) is already fully represented by the
// system/compact_boundary divider (CompactBoundaryBlock) — and for /compact, by
// the isCompactSummary block too. The CLI ALSO emits the raw command-echo trio
// (caveat + `<command-name>/compact` + `<local-command-stdout>Compacted`), which
// would dangle two redundant grey lines right under the nice divider. Drop just
// the compact/clear echo; other slash-command echoes (e.g. `/model sonnet`) stay,
// since those carry info no other block surfaces.
function isCompactCommandEcho(rec: Record<string, unknown> | null | undefined): boolean {
  if (!rec || rec.type !== "user") return false;
  const content = (rec.message as { content?: unknown } | undefined)?.content;
  if (typeof content !== "string") return false;
  if (/^<command-name>\s*\/?(compact|clear)\b/i.test(content)) return true;
  const out = content.match(/^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  return !!out && /^(compacted|cleared)\b/i.test((out[1] ?? "").trim());
}

// Background-task completion notice injected by claude-code as a user-turn
// whose content is a `<task-notification>…</task-notification>` blob. Rendered
// as a compact chip via TaskNotificationBlock instead of the raw XML.
function isTaskNotification(rec: Record<string, unknown> | null | undefined): boolean {
  if (!rec || rec.type !== "user") return false;
  const content = (rec.message as { content?: unknown } | undefined)?.content;
  return typeof content === "string" && content.trimStart().startsWith("<task-notification>");
}

export function pickBlock(rec: unknown): BlockKind | null {
  const r = asLoose(rec);
  if (isResumeArtifact(r)) return null;
  if (isLocalCommandCaveat(r)) return null;
  if (isCompactCommandEcho(r)) return null;
  if (isLocalCommandUserShape(r)) return "LocalCommandBlock";
  if (isTaskNotification(r)) return "TaskNotificationBlock";
  if (isUser(r)) {
    if (hasIsCompactSummary(r)) return "UserCompactSummaryBlock";
    // isMeta user records are harness-injected context (skill content,
    // base-directory injections, caveats…) the CLI never shows — drop them
    // like resume artifacts instead of rendering a noisy "meta ·" row.
    if (hasIsMeta(r)) return null;
    if (isUserToolResultShape(r)) return "UserToolResultBlock";
    if (isUserPromptShape(r)) return "UserPromptBlock";
    return "UserPromptBlock";
  }
  if (isAssistant(r)) {
    return hasIsApiErrorMessage(r) ? "AssistantApiErrorBlock" : "AssistantBlock";
  }
  if (isSystem(r)) {
    switch (systemSubtype(r)) {
      case "turn_duration": return "TurnDurationBlock";
      case "stop_hook_summary": return null;  // not rendered on web
      case "away_summary": return "AwaySummaryBlock";
      case "local_command": return "LocalCommandBlock";
      case "api_error": return "ApiErrorBlock";
      case "empty_completion": return "EmptyCompletionBlock";
      case "compact_boundary": return "CompactBoundaryBlock";
      default: return null;
    }
  }
  return null;
}
