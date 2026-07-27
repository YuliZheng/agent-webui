// Frontend-only adapter: codex rollout records → claude-shaped jsonl record
// strings, so the existing groupTimeline / block components render codex
// sessions with no new render code. Codex content is tailed from the rollout
// file (same as claude tails its jsonl), so this handles BOTH webui-driven and
// terminal codex turns. The backend stays raw (forwards rollout lines verbatim);
// this agent-gated translation lives entirely in the frontend.
//
// Each codex line is a rollout record: { timestamp, type, payload }.
//   - event_msg/user_message  → user bubble (clean typed text, incl. image trailer)
//   - event_msg/agent_message → assistant bubble (final answer text)
//   - event_msg/thread_rolled_back → logically drop the last N turns
//   - event_msg/turn_aborted → "[Request interrupted by user]" marker (parity
//     with claude's interrupt), appended to the aborted turn
//   - response_item/function_call (+ /function_call_output) → tool call pair
//   - everything else (session_meta, turn_context, reasoning, response_item
//     message duplicates, token_count, task_*) → dropped
//
// function_call and its output are SEPARATE rollout records paired by call_id;
// we emit a claude tool_use + tool_result with the same id and let groupTimeline
// collapse them into one ToolCall row (exactly how claude tool pairs work).

function claudeUser(uuid: string, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    message: { role: "user", content: text },
  });
}

interface PendingCodexImages {
  sourceLineIndex: number;
  mediaTypes: string[];
}

interface CodexUserImageRecord {
  isUserMessage: true;
  pending: PendingCodexImages | null;
}

function codexUserImageRecord(rawLine: string, lineIndex: number): CodexUserImageRecord | null {
  // Avoid JSON.parse on the overwhelmingly common non-image records.
  if (!rawLine.includes("response_item") || !rawLine.includes("message")) return null;
  let rec: Record<string, unknown>;
  try { rec = JSON.parse(rawLine) as Record<string, unknown>; } catch { return null; }
  if (rec.type !== "response_item") return null;
  const payload = (rec.payload ?? {}) as Record<string, unknown>;
  if (payload.type !== "message" || payload.role !== "user") return null;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const mediaTypes = content.flatMap(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const block = raw as Record<string, unknown>;
    if (block.type === "input_image") {
      const url = typeof block.image_url === "string"
        ? block.image_url
        : typeof block.imageUrl === "string" ? block.imageUrl : "";
      const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(url);
      return match?.[1] ? [match[1].toLowerCase()] : [];
    }
    if (block.type !== "image" || !block.source || typeof block.source !== "object" || Array.isArray(block.source)) return [];
    const source = block.source as Record<string, unknown>;
    const mediaType = typeof source.media_type === "string"
      ? source.media_type
      : typeof source.mediaType === "string" ? source.mediaType : "";
    return source.type === "base64" && mediaType.startsWith("image/") ? [mediaType] : [];
  });
  return {
    isUserMessage: true,
    pending: mediaTypes.length ? { sourceLineIndex: lineIndex, mediaTypes } : null,
  };
}

function imageExtension(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/svg+xml") return "svg";
  return mediaType.split("/")[1]?.replace(/[^a-z0-9]+/gi, "") || "img";
}

function attachCodexImages(rawUser: string, pending: PendingCodexImages): string {
  let record: Record<string, any>;
  try { record = JSON.parse(rawUser) as Record<string, any>; } catch { return rawUser; }
  const message = record.message && typeof record.message === "object"
    ? record.message as Record<string, any>
    : null;
  if (!message) return rawUser;
  const rawText = typeof message.content === "string" ? message.content : "";
  // Codex's clean event message uses placeholders such as
  // `[Image #1]caption`. The image gets its own bubble, so suppress only the
  // leading placeholders when a real image record was paired successfully.
  const text = rawText.replace(/^(?:\s*\[Image #\d+\])+\s*/iu, "");
  message.content = [
    ...pending.mediaTypes.map((mediaType, imageIndex) => ({
      type: "image",
      source: {
        type: "agent-webui-transcript",
        lineIndex: pending.sourceLineIndex,
        imageIndex,
        media_type: mediaType,
      },
      name: `image-${imageIndex + 1}.${imageExtension(mediaType)}`,
    })),
    ...(text ? [{ type: "text", text }] : []),
  ];
  // groupTimeline preserves this instead of replacing it with the adapted
  // array index, which is unrelated to the physical rollout line.
  record.__agentWebuiSourceIndex = pending.sourceLineIndex;
  return JSON.stringify(record);
}

function claudeAssistantText(uuid: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    message: { role: "assistant", model: "codex", content: [{ type: "text", text }] },
  });
}

function claudeToolUse(callId: string, name: string, input: unknown): string {
  return JSON.stringify({
    type: "assistant",
    uuid: callId,
    message: { role: "assistant", model: "codex", content: [{ type: "tool_use", id: callId, name, input: input ?? {} }] },
  });
}

function claudeToolResult(callId: string, output: string): string {
  return JSON.stringify({
    type: "user",
    uuid: `${callId}:result`,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: output }] },
  });
}

function claudeCompactBoundary(uuid: string): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    uuid,
    content: "Conversation compacted",
    compactMetadata: { trigger: "manual" },
  });
}

// codex exec_command output is prefixed with "Chunk ID:…\nWall time:…\nProcess
// exited with code N\nOriginal token count:…\nOutput:\n<actual>". Show just the
// actual output, with a trailing exit-code note when non-zero.
function cleanExecOutput(raw: string): string {
  const out = raw.includes("\nOutput:\n") ? raw.split("\nOutput:\n").slice(1).join("\nOutput:\n") : raw;
  const exit = /exited with code (\d+)/.exec(raw)?.[1];
  return exit !== undefined && exit !== "0" ? `${out}\n(exit ${exit})` : out;
}

// Per-line adaptation is pure: a rollout record's content at a given index is
// immutable once written, so its adapted output never changes. Cache it. The
// call site (`renderLines` in MessageList) re-runs this over the WHOLE lines
// array on every reactive tick — restore merge, the tail batch, and every live
// stream record — so without memoization a multi-thousand-line codex rollout
// pays JSON.parse × N per tick, which is the seconds-long codex-only open/stream
// stall claude (whose renderLines is a zero-cost passthrough) never has. Keyed
// by index + content so a stream-reset/truncate that swaps a slot's content
// misses cleanly instead of returning stale output.
const adaptCache = new Map<string, string[]>();
// Rollback/truncate orphan old keys; bound the map so a long-lived tab can't
// grow it without limit. Overflow just clears and re-warms on the next pass.
const ADAPT_CACHE_MAX = 50_000;

function adaptLineCached(rawLine: string, lineIndex: number): string[] {
  const key = lineIndex + " " + rawLine;
  let out = adaptCache.get(key);
  if (out === undefined) {
    if (adaptCache.size >= ADAPT_CACHE_MAX) adaptCache.clear();
    out = codexToClaudeLines(rawLine, lineIndex);
    adaptCache.set(key, out);
  }
  return out;
}

export function codexRolloutToClaudeLines(rawLines: string[]): string[] {
  const turns: string[][] = [];
  let current: string[] | null = null;
  let pendingImages: PendingCodexImages | null = null;
  const add = (line: string) => {
    if (!current) { current = []; turns.push(current); }
    current.push(line);
  };

  rawLines.forEach((rawLine, lineIndex) => {
    if (!rawLine) return;
    const imageRecord = codexUserImageRecord(rawLine, lineIndex);
    if (imageRecord) pendingImages = imageRecord.pending;
    if (pendingImages && lineIndex - pendingImages.sourceLineIndex > 4) pendingImages = null;
    for (const line of adaptLineCached(rawLine, lineIndex)) {
      if (line === ROLLBACK_SENTINEL) {
        const drop = rollbackCount(rawLine);
        if (drop > 0) turns.splice(Math.max(0, turns.length - drop), drop);
        current = turns.length ? turns[turns.length - 1]! : null;
      } else if (line.startsWith(USER_SENTINEL)) {
        let user = line.slice(USER_SENTINEL.length);
        if (pendingImages) user = attachCodexImages(user, pendingImages);
        pendingImages = null;
        current = [user];
        turns.push(current);
      } else {
        add(line);
      }
    }
  });

  return turns.flat();
}

export function codexToClaudeLines(rawLine: string, lineIndex?: number): string[] {
  let rec: Record<string, unknown>;
  try { rec = JSON.parse(rawLine) as Record<string, unknown>; } catch { return []; }
  const p = (rec.payload ?? {}) as Record<string, unknown>;

  if (rec.type === "event_msg") {
    if (p.type === "user_message" && typeof p.message === "string") {
      const id = typeof p.id === "string" ? p.id : codexLineId(lineIndex);
      return [USER_SENTINEL + claudeUser(id, p.message)];
    }
    if (p.type === "agent_message" && typeof p.message === "string") {
      return [claudeAssistantText(stableId("a", lineIndex), p.message)];
    }
    if (p.type === "thread_rolled_back") {
      return [ROLLBACK_SENTINEL];
    }
    if (p.type === "context_compacted") {
      return [claudeCompactBoundary(stableId("compact", lineIndex))];
    }
    if (p.type === "turn_aborted") {
      // Interrupt marker — same text claude writes when you stop a turn. No
      // USER_SENTINEL so it appends to the CURRENT (aborted) turn instead of
      // starting a new one: keeps display-turn count aligned with codex's
      // user-message turns (rollback/rewind splices by that count) and lets it
      // be dropped together with the turn it belongs to on rewind.
      return [claudeUser(stableId("abort", lineIndex), "[Request interrupted by user]")];
    }
    return [];
  }

  if (rec.type === "response_item") {
    const callId = typeof p.call_id === "string" ? p.call_id : "";
    if (p.type === "function_call" && callId) {
      const name = typeof p.name === "string" ? p.name : "tool";
      let args: unknown = {};
      try { args = typeof p.arguments === "string" ? JSON.parse(p.arguments) : (p.arguments ?? {}); } catch { args = { raw: p.arguments }; }
      if (name === "exec_command" || name === "shell") {
        const cmd = (args as { cmd?: string; command?: string }).cmd ?? (args as { command?: string }).command ?? "";
        return [claudeToolUse(callId, "Bash", { command: cmd })];
      }
      // apply_patch / web_search / mcp / custom tools → generic tool-call row.
      return [claudeToolUse(callId, name, args)];
    }
    if (p.type === "function_call_output" && callId) {
      const raw = typeof p.output === "string" ? p.output
        : typeof (p.output as { content?: unknown })?.content === "string" ? (p.output as { content: string }).content
        : JSON.stringify(p.output ?? "");
      return [claudeToolResult(callId, cleanExecOutput(raw))];
    }
    // response_item/message (developer + injected env_context + assistant
    // duplicates) and reasoning are dropped — event_msg carries clean text.
    return [];
  }

  return [];
}

const USER_SENTINEL = "\u0000user:";
const ROLLBACK_SENTINEL = "\u0000rollback";

function codexLineId(lineIndex: number | undefined): string {
  return typeof lineIndex === "number" && Number.isFinite(lineIndex)
    ? `codex-line-${lineIndex}`
    : `u-${Math.random().toString(36).slice(2)}`;
}

function stableId(prefix: string, lineIndex: number | undefined): string {
  return typeof lineIndex === "number" && Number.isFinite(lineIndex)
    ? `${prefix}-${lineIndex}`
    : `${prefix}-${Math.random().toString(36).slice(2)}`;
}

function rollbackCount(rawLine: string): number {
  try {
    const rec = JSON.parse(rawLine) as { payload?: { num_turns?: unknown } };
    const n = rec.payload?.num_turns;
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
