import type { IndexedRawLine, NormalizedBlock } from "@/types";
import { isRecord, textOf } from "@/util/storage";

function base(line: IndexedRawLine, record: Record<string, unknown>, suffix = ""): Pick<NormalizedBlock, "key" | "index" | "sourceIndexes" | "agent" | "uuid" | "parentUuid" | "sidechain" | "agentId" | "timestamp"> {
  return {
    key: `claude-${line.index}${suffix}`,
    index: line.index,
    sourceIndexes: [line.index],
    agent: "claude",
    uuid: typeof record.uuid === "string" ? record.uuid : undefined,
    parentUuid: typeof record.parentUuid === "string" ? record.parentUuid : null,
    sidechain: record.isSidechain === true,
    agentId: typeof record.agentId === "string" ? record.agentId : undefined,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined
  };
}

function message(record: Record<string, unknown>): Record<string, unknown> {
  return isRecord(record.message) ? record.message : record;
}

export function normalizeClaudeLine(line: IndexedRawLine): NormalizedBlock[] {
  let record: Record<string, unknown>;
  try { const parsed = JSON.parse(line.raw) as unknown; if (!isRecord(parsed)) return []; record = parsed; } catch { return []; }
  const type = typeof record.type === "string" ? record.type : "unknown";
  if (type === "queue-operation" || type === "file-history-snapshot" || type === "permission-mode" || type === "custom-title" || type === "last-prompt") return [];
  if (type === "attachment") {
    if (record.attachmentType === "queued_command" || record.type === "queued_command" || (isRecord(record.attachment) && record.attachment.type === "queued_command")) {
      const payload = isRecord(record.attachment) ? record.attachment : record;
      const text = textOf(payload.prompt ?? payload.command ?? payload.content);
      return text ? [{ ...base(line, record), kind: "user", text, meta: { queuedCommand: true } }] : [];
    }
    return [];
  }
  if (type === "user") return normalizeUser(line, record);
  if (type === "assistant") return normalizeAssistant(line, record);
  if (type === "system") return normalizeSystem(line, record);
  if (import.meta.env.DEV) return [{ ...base(line, record), kind: "unknown", text: type }];
  return [];
}

function normalizeUser(line: IndexedRawLine, record: Record<string, unknown>): NormalizedBlock[] {
  const msg = message(record);
  const content = msg.content;
  if (record.isMeta === true || msg.isMeta === true) return [];
  if (record.isCompactSummary === true || msg.isCompactSummary === true) {
    return [{ ...base(line, record), kind: "compact-summary", text: textOf(content) }];
  }
  if (typeof content === "string") {
    const special = normalizeUserString(line, record, content);
    if (special !== null) return special;
    return content.trim() ? [{ ...base(line, record), kind: "user", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    const text = textOf(content); return text ? [{ ...base(line, record), kind: "user", text }] : [];
  }
  const toolResults: NormalizedBlock[] = [];
  const texts: string[] = [];
  const images: string[] = [];
  const pdfs: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "tool_result") {
      const structured = part.toolUseResult ?? record.toolUseResult;
      toolResults.push({
        ...base(line, record, `-result-${toolResults.length}`), kind: "tool-result",
        toolUseId: typeof part.tool_use_id === "string" ? part.tool_use_id : undefined,
        text: textOf(part.content), toolResult: structured ?? part.content, isError: part.is_error === true
      });
    } else if (part.type === "image" && isRecord(part.source)) {
      if (typeof part.source.data === "string") images.push(`data:${String(part.source.media_type ?? "image/png")};base64,${part.source.data}`);
    } else if (part.type === "document") {
      const source = isRecord(part.source) ? part.source : undefined;
      const mediaType = String(source?.media_type ?? part.media_type ?? "");
      if (mediaType === "application/pdf" || source?.type === "base64") {
        const name = [part.filename, part.file_name, part.name, part.title, source?.filename, source?.file_name]
          .find((value): value is string => typeof value === "string" && value.trim().length > 0);
        pdfs.push(name?.trim() || `document-${pdfs.length + 1}.pdf`);
      }
    } else {
      const text = textOf(part);
      if (text) texts.push(text);
    }
  }
  const prompt = texts.join("\n").trim();
  if (!toolResults.length && !images.length && !pdfs.length && prompt) {
    const special = normalizeUserString(line, record, prompt);
    if (special !== null) return special;
  }
  const promptBlock = prompt || images.length || pdfs.length
    ? [{
        ...base(line, record),
        kind: "user" as const,
        text: prompt,
        images,
        ...(pdfs.length ? { meta: { pdfs } } : {})
      }]
    : [];
  return [...promptBlock, ...toolResults];
}

function normalizeAssistant(line: IndexedRawLine, record: Record<string, unknown>): NormalizedBlock[] {
  const msg = message(record);
  if (record.isApiErrorMessage === true || msg.isApiErrorMessage === true || msg.error) {
    return [{ ...base(line, record), kind: "api-error", text: textOf(msg.content) || String(msg.error ?? "API error"), isError: true }];
  }
  const content = msg.content;
  if (typeof content === "string") return content ? [{ ...base(line, record), kind: "assistant", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: NormalizedBlock[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string" && part.text) {
      blocks.push({ ...base(line, record, `-text-${blocks.length}`), kind: "assistant", text: part.text });
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      blocks.push({ ...base(line, record, `-thinking-${blocks.length}`), kind: "thinking", text: part.thinking });
    } else if (part.type === "tool_use") {
      blocks.push({
        ...base(line, record, `-tool-${blocks.length}`), kind: "tool",
        toolUseId: typeof part.id === "string" ? part.id : undefined,
        toolName: typeof part.name === "string" ? part.name : "Tool",
        toolInput: part.input
      });
    }
  }
  const usage = isRecord(msg.usage) ? msg.usage : isRecord(record.usage) ? record.usage : undefined;
  return usage ? blocks.map((block) => ({ ...block, meta: { ...block.meta, usage } })) : blocks;
}

function normalizeSystem(line: IndexedRawLine, record: Record<string, unknown>): NormalizedBlock[] {
  const subtype = String(record.subtype ?? "");
  const text = textOf(record.content ?? record.message ?? record.summary);
  if (subtype.includes("compact") || record.compactMetadata) return [{ ...base(line, record), kind: "compact-boundary", text }];
  if (subtype.includes("duration") || typeof record.durationMs === "number") return [{ ...base(line, record), kind: "duration", text: text || `${Number(record.durationMs) / 1000}s` }];
  if (subtype.includes("error")) return [{ ...base(line, record), kind: "api-error", text: text || subtype, isError: true }];
  if (subtype.includes("local_command") || record.isLocalCommand === true) return [{ ...base(line, record), kind: "local-command", text }];
  if (subtype.includes("task_notification")) return [{ ...base(line, record), kind: "task-notification", text }];
  if (subtype.includes("away_summary")) return [{ ...base(line, record), kind: "away-summary", text }];
  return [];
}

function normalizeUserString(
  line: IndexedRawLine,
  record: Record<string, unknown>,
  content: string,
): NormalizedBlock[] | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("<")) return null;

  if (/^<(?:command-name|local-command-(?:stdout|stderr))>/i.test(trimmed)) {
    const command = tagText(trimmed, "command-name").trim();
    if (/^\/(?:compact|clear)(?:\s|$)/i.test(command)) return [];
    const stdout = tagText(trimmed, "local-command-stdout").trim();
    const stderr = tagText(trimmed, "local-command-stderr").trim();
    const args = tagText(trimmed, "command-args").trim();
    const visible = [
      command && args ? `${command} ${args}` : command,
      stdout,
      stderr,
    ].filter(Boolean).join("\n");
    return [{
      ...base(line, record),
      kind: "local-command",
      text: visible || stripXml(trimmed),
      meta: { command, stdout, stderr },
      isError: !!stderr,
    }];
  }

  if (/^<task-notification>/i.test(trimmed)) {
    const status = tagText(trimmed, "status").trim();
    const summary = (
      tagText(trimmed, "summary") ||
      tagText(trimmed, "message") ||
      tagText(trimmed, "result")
    ).trim();
    const taskId = tagText(trimmed, "task-id").trim();
    return [{
      ...base(line, record),
      kind: "task-notification",
      text: summary || status || taskId || stripXml(tagText(trimmed, "task-notification")),
      isError: /fail|error/i.test(status),
      meta: { status, taskId },
    }];
  }

  return null;
}

function tagText(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"))?.[1] ?? "";
}

function stripXml(source: string): string {
  return source
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
