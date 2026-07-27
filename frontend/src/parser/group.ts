import {
  isUser, isAssistant, isSidechain,
  isQueueOperation, isQueuedCommandAttachment,
} from "@claude-webui/shared/discriminate";
import { pickBlock, type BlockKind } from "./dispatch.js";

export interface ToolUseRef {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface PreviewMarker {
  summary: string;
  path: string;
}
export interface ToolPair {
  use: ToolUseRef;
  result: unknown | undefined;
  subagentTimeline?: TimelineNode[];
  preview?: PreviewMarker;
  workflow?: WorkflowInfo;
}

// Workflow/TaskOutput results for local_workflow tasks carry a progress trail
// (toolUseResult.task.workflowProgress, or embedded in the task.output JSON
// string). Kept loosely typed — the shapes come from the CLI and may evolve;
// the renderer picks fields defensively.
export type WorkflowProgressEntry = Record<string, unknown>;
export interface WorkflowInfo {
  description: string;
  entries: WorkflowProgressEntry[];
}

function workflowProgressIn(rec: Record<string, unknown>): WorkflowInfo | undefined {
  const task = (rec.toolUseResult as { task?: unknown } | undefined)?.task;
  if (!task || typeof task !== "object") return undefined;
  const t = task as Record<string, unknown>;
  let wp: unknown = t.workflowProgress;
  // Observed in the wild: task.workflowProgress is null and the real array
  // lives inside task.output, a JSON string of the workflow's final report.
  if (!Array.isArray(wp) && typeof t.output === "string" && t.output.includes('"workflowProgress"')) {
    try {
      wp = (JSON.parse(t.output) as { workflowProgress?: unknown })?.workflowProgress;
    } catch { /* malformed/truncated output — fall back to text rendering */ }
  }
  if (!Array.isArray(wp) || wp.length === 0) return undefined;
  const entries = wp.filter((e): e is WorkflowProgressEntry => !!e && typeof e === "object");
  if (entries.length === 0) return undefined;
  return { description: typeof t.description === "string" ? t.description : "", entries };
}

// Wrapper script (local/bin/cwui-preview) emits a single line of the form
//   __CWUI_PREVIEW__ {"summary":"...","path":"/preview/<uuid>/index.html"}
// inside a Bash tool_result. Detecting this in the parser keeps render code
// from having to special-case generic tool output.
const PREVIEW_MARKER_RE = /^__CWUI_PREVIEW__ (\{.*\})\s*$/m;
const PREVIEW_PATH_RE = /^\/preview\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/index\.html$/;

function resultText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) {
    return payload.map((b: any) => {
      if (b?.type === "text" && typeof b.text === "string") return b.text;
      return "";
    }).join("\n");
  }
  return "";
}

export function extractPreviewMarker(payload: unknown): PreviewMarker | undefined {
  const text = resultText(payload);
  if (!text) return undefined;
  const m = PREVIEW_MARKER_RE.exec(text);
  if (!m || !m[1]) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(m[1]); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const o = parsed as Record<string, unknown>;
  const summary = typeof o.summary === "string" ? o.summary : "";
  const path = typeof o.path === "string" ? o.path : "";
  if (!summary || !path) return undefined;
  if (!PREVIEW_PATH_RE.test(path)) return undefined;
  return { summary, path };
}

export type TimelineNode =
  | { kind: "event"; record: Record<string, unknown>; block: BlockKind | null; toolPairs?: ToolPair[] };

function recObj(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    // Mid-turn queued prompts arrive as attachment(queued_command). Render as
    // user bubbles by synthesizing a user record; the chip strip in
    // MessageList.vue is what shows them while still queued.
    if (isQueuedCommandAttachment(o)) {
      const synth: Record<string, unknown> = {
        type: "user",
        message: { role: "user", content: o.attachment.prompt },
        uuid: o.uuid,
        timestamp: o.timestamp,
        sessionId: o.sessionId,
      };
      if (o.parentUuid) synth.parentUuid = o.parentUuid;
      return synth;
    }
    // Other attachment subtypes should already be filtered by the BE; if any
    // slip through, drop here.
    if (o.type === "attachment") return null;
    // queue-operation records drive the chip strip, not the timeline.
    if (isQueueOperation(o)) return null;
    return o;
  } catch { return null; }
}

function toolUsesIn(rec: Record<string, unknown>): ToolUseRef[] {
  const m = (rec.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(m)) return [];
  const out: ToolUseRef[] = [];
  for (const b of m) {
    const o = b as Record<string, unknown>;
    if (o?.type === "tool_use" && typeof o.id === "string" && typeof o.name === "string") {
      out.push({ id: o.id, name: o.name, input: (o.input as Record<string, unknown>) ?? {} });
    }
  }
  return out;
}

function toolResultIn(rec: Record<string, unknown>): { id: string; payload: unknown } | null {
  const m = (rec.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(m)) return null;
  for (const b of m) {
    const o = b as Record<string, unknown>;
    if (o?.type === "tool_result" && typeof o.tool_use_id === "string") {
      return { id: o.tool_use_id, payload: o.content };
    }
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// What the user actually picked, rendered as their own conversation turn. The
// AskUserQuestion tool_result is the native `User has answered your questions:
// "Q"="A".` string; pull out just the answer value(s) so the synthetic user
// bubble reads like a typed reply rather than tool plumbing. Falls back to the
// injected `answers` map (updatedInput) when present.
function askAnswerText(input: Record<string, unknown> | undefined, payload: unknown): string {
  const text = resultText(payload);
  const map = (input?.answers && typeof input.answers === "object")
    ? input.answers as Record<string, string> : null;
  const questions = Array.isArray(input?.questions)
    ? input!.questions as Array<{ question?: string; header?: string }> : [];
  if (questions.length) {
    const parts: string[] = [];
    for (const q of questions) {
      const qt = typeof q.question === "string" ? q.question : "";
      let a = qt && map && typeof map[qt] === "string" ? map[qt] : undefined;
      if (a === undefined && qt) {
        const m = text.match(new RegExp(`"${escapeRe(qt)}"\\s*=\\s*"([^"]*)"`));
        a = m ? m[1] : "";
      }
      if (questions.length === 1) return a ?? "";
      parts.push(`${q.header || qt}: ${a ?? ""}`);
    }
    return parts.join("\n");
  }
  return text.replace(/^User has answered your questions:\s*/, "").trim();
}

export function groupTimeline(rawLines: string[]): TimelineNode[] {
  const records: Array<{ rec: Record<string, unknown> }> = [];
  for (let sourceIndex = 0; sourceIndex < rawLines.length; sourceIndex++) {
    const line = rawLines[sourceIndex]!;
    const r = recObj(line);
    if (!r) continue;
    // Preserve the physical transcript line for structured image blocks.
    // Codex-adapted records already point at the response_item line that owns
    // their image bytes; native Claude records use their array/source index.
    if (!Number.isSafeInteger(r.__agentWebuiSourceIndex)) {
      r.__agentWebuiSourceIndex = sourceIndex;
    }
    records.push({ rec: r });
  }
  return groupRecords(records.map(({ rec }) => rec));
}

function groupRecords(allRecords: Record<string, unknown>[]): TimelineNode[] {
  const sidechainByParent = new Map<string, Record<string, unknown>[]>();
  for (const rec of allRecords) {
    if (!isSidechain(rec)) continue;
    const parent = (rec.parentUuid as string | undefined) ?? (rec.logicalParentUuid as string | undefined);
    if (!parent) continue;
    const list = sidechainByParent.get(parent) ?? [];
    list.push(rec);
    sidechainByParent.set(parent, list);
  }

  const main = allRecords.filter((rec) => !isSidechain(rec)).map((rec) => ({ rec }));

  const pendingResults = new Map<string, unknown>();
  const workflowById = new Map<string, WorkflowInfo>();
  for (const { rec } of main) {
    if (!isUser(rec)) continue;
    const tr = toolResultIn(rec);
    if (!tr) continue;
    pendingResults.set(tr.id, tr.payload);
    const wf = workflowProgressIn(rec);
    if (wf) workflowById.set(tr.id, wf);
  }

  // Map each AskUserQuestion tool_use id → its input, so when the matching
  // tool_result lands we can surface the user's pick as their own message
  // bubble (see the synthetic node emitted in the main loop below).
  const askInputById = new Map<string, Record<string, unknown>>();
  for (const { rec } of main) {
    if (!isAssistant(rec)) continue;
    for (const u of toolUsesIn(rec)) {
      if (u.name === "AskUserQuestion") askInputById.set(u.id, u.input);
    }
  }

  const timeline: TimelineNode[] = [];
  // Defensive dedup by uuid. A rewind+resume can re-append messages that
  // already exist earlier on disk with the SAME uuid (observed in the wild:
  // a truncate-then-resume left a 16-message span duplicated). The transcript
  // is cached by line index, not uuid, so without this the duplicated span
  // renders twice and the conversation looks corrupted. Keep the first
  // occurrence of each uuid; drop any later record carrying the same one.
  const seenUuids = new Set<string>();
  for (const { rec } of main) {
    const tr = isUser(rec) ? toolResultIn(rec) : null;
    if (tr !== null) {
      // An answered AskUserQuestion: emit a synthetic user-prompt node so the
      // pick renders as the user's own (right-aligned) conversation turn,
      // exactly like a typed reply. Every other tool_result stays folded into
      // its assistant pair (skipped here).
      const askInput = askInputById.get(tr.id);
      if (askInput) {
        const answer = askAnswerText(askInput, tr.payload);
        if (answer) {
          timeline.push({
            kind: "event",
            block: "UserPromptBlock",
            record: {
              type: "user",
              message: { role: "user", content: answer },
              timestamp: rec.timestamp,
            },
          });
        }
      }
      continue;
    }

    const uuid = typeof rec.uuid === "string" ? rec.uuid : "";
    if (uuid) {
      if (seenUuids.has(uuid)) continue;
      seenUuids.add(uuid);
    }

    const kind = pickBlock(rec);
    const node: TimelineNode = { kind: "event", record: rec, block: kind };

    if (isAssistant(rec)) {
      const uses = toolUsesIn(rec);
      if (uses.length) {
        node.toolPairs = uses.map((u) => {
          const result = pendingResults.get(u.id);
          const pair: ToolPair = { use: u, result };
          const preview = extractPreviewMarker(result);
          if (preview) pair.preview = preview;
          const workflow = workflowById.get(u.id);
          if (workflow) pair.workflow = workflow;
          if (u.name === "Agent") {
            const parentUuid = (rec.uuid as string | undefined) ?? "";
            const sidechain = sidechainByParent.get(parentUuid) ?? [];
            // Strip isSidechain so the recursion treats them as main-line entries.
            const stripped = sidechain.map((r) => {
              const { isSidechain: _ignored, ...rest } = r as Record<string, unknown>;
              return rest as Record<string, unknown>;
            });
            pair.subagentTimeline = groupRecords(stripped);
          }
          return pair;
        });
      }
    }
    timeline.push(node);
  }
  return timeline;
}
