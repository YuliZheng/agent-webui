import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexExecutable } from "../util/executable.js";
import {
  normalizeCanonicalTitle,
  normalizeTitleEmoji,
  splitTitleEmoji,
} from "./session-title.js";

export interface GeneratedSessionTitle {
  title: string;
  emoji: string;
  /** Compact accumulated topic context for the next title refresh. */
  summary?: string;
}

export interface SessionTitleRequest {
  text: string;
  language: string;
  previousSummary?: string;
}

export type SessionTitleGenerator = (
  request: SessionTitleRequest,
) => Promise<GeneratedSessionTitle>;

export const SESSION_TITLE_MODEL = "gpt-5.3-codex-spark";
export const SESSION_TITLE_REASONING_EFFORT = "low";
const TITLE_TIMEOUT_MS = 45_000;
export const SESSION_TITLE_TEXT_MAX_CHARS = 6_400;
export const SESSION_TOPIC_SUMMARY_MAX_CHARS = 600;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "emoji", "summary"],
  properties: {
    title: {
      type: "string",
      description: "A concise session title without a trailing emoji.",
      maxLength: 50,
    },
    emoji: {
      type: "string",
      description: "Exactly one relevant emoji grapheme.",
    },
    summary: {
      type: "string",
      description: "A compact rolling summary of the chat's overall topic for the next refresh.",
      maxLength: SESSION_TOPIC_SUMMARY_MAX_CHARS,
    },
  },
} as const;

function truncateGraphemes(value: string, max: number): string {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
    .slice(0, max)
    .map(part => part.segment)
    .join("");
}

export function fallbackTitleEmoji(text: string): string {
  const value = text.toLocaleLowerCase();
  const choices: Array<[RegExp, string]> = [
    [/(?:bug|fix|error|crash|debug|修复|报错|错误|故障|排查)/u, "🛠️"],
    [/(?:search|research|find|lookup|搜索|查找|调研|研究)/u, "🔎"],
    [/(?:travel|flight|hotel|trip|旅行|旅游|航班|酒店)/u, "✈️"],
    [/(?:mail|email|inbox|邮件|邮箱)/u, "✉️"],
    [/(?:fitness|workout|training|protein|健身|训练|蛋白)/u, "💪"],
    [/(?:food|meal|restaurant|takeout|吃|餐厅|外卖|饮食)/u, "🍽️"],
    [/(?:image|design|ui|ux|视觉|图片|设计|界面)/u, "🎨"],
    [/(?:document|report|write|文章|文档|报告|写作)/u, "📝"],
    [/(?:stock|finance|money|budget|股票|金融|预算|价格)/u, "📈"],
    [/(?:code|api|frontend|backend|test|代码|前端|后端|测试)/u, "💻"],
  ];
  return choices.find(([pattern]) => pattern.test(value))?.[1] ?? "💬";
}

export function normalizeGeneratedSessionTitle(
  value: unknown,
  sourceText: string,
): GeneratedSessionTitle | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const parts = splitTitleEmoji(record.title);
  const rawTitle = parts.title;
  if (!rawTitle) return null;
  const title = normalizeCanonicalTitle(truncateGraphemes(rawTitle, 48));
  if (!title) return null;
  const emoji = normalizeTitleEmoji(record.emoji) ?? parts.emoji ?? fallbackTitleEmoji(sourceText);
  const summary = normalizeTopicSummary(record.summary)
    || normalizeTopicSummary(sourceText);
  return { title, emoji, ...(summary ? { summary } : {}) };
}

export function normalizeTopicSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  return truncateGraphemes(normalized, SESSION_TOPIC_SUMMARY_MAX_CHARS);
}

export function fallbackTopicSummary(
  previousSummary: string | undefined,
  newContext: string,
): string {
  const previous = normalizeTopicSummary(previousSummary);
  const current = normalizeTopicSummary(newContext);
  if (!previous) return current;
  if (!current || previous.toLocaleLowerCase().includes(current.toLocaleLowerCase())) return previous;
  return normalizeTopicSummary(
    `${truncateGraphemes(previous, 360)} ${truncateGraphemes(current, 230)}`,
  );
}

function titlerPrompt(request: SessionTitleRequest): string {
  const language = request.language.trim() || "auto";
  const previousSummary = normalizeTopicSummary(request.previousSummary);
  const newContextBudget = Math.max(
    800,
    SESSION_TITLE_TEXT_MAX_CHARS - previousSummary.length,
  );
  return [
    "Update the rolling topic summary and name this coding-agent chat based on its overall purpose.",
    "Do not inspect files, use tools, or perform the requests.",
    "Return only the JSON object required by the output schema.",
    "PREVIOUS TOPIC SUMMARY is accumulated history. CONVERSATION-WIDE samples may cover the beginning, middle, and end of the chat.",
    "Combine all supplied history instead of merely naming the newest request or the last few requests.",
    "Prefer the enduring goal or recurring project that best explains the whole timeline. Recent messages usually describe progress within that goal.",
    "Preserve the established central topic while requests continue the same work, even when the latest request is short or locally specific.",
    "Only replace the central topic when the new requests clearly abandon it and start unrelated work.",
    "Write summary as a compact 1-3 sentence account of the original goal, important developments, and current active direction.",
    "Do not mention that the summary is rolling, previous, or generated.",
    "Name the overall active task specifically; never use a generic title such as 'Continue' or 'Follow-up'.",
    "The title must be specific, natural, at most 48 characters, and contain no emoji.",
    "Choose exactly one visually distinctive emoji that best represents the topic.",
    language.toLocaleLowerCase() === "auto"
      ? "Use the same language as the supplied requests for both title and summary."
      : `Write both title and summary in ${language}.`,
    "",
    "PREVIOUS TOPIC SUMMARY:",
    previousSummary || "(none; establish it from the new requests)",
    "",
    "NEW USER REQUESTS:",
    request.text.trim().slice(0, newContextBudget),
    "",
    "Now synthesize the title and summary from the conversation as a whole; do not default to its final entry.",
  ].join("\n");
}

/**
 * Runs tiny, ephemeral, structured Codex jobs one at a time. Serializing them
 * prevents a burst of completed sessions or "Re-title all" from launching
 * hundreds of native processes and making the host unresponsive.
 */
export class CodexSessionTitleGenerator {
  private binaryPromise?: Promise<string>;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly configuredBinary = "codex",
    private readonly model = SESSION_TITLE_MODEL,
  ) {}

  generate: SessionTitleGenerator = request => {
    const operation = this.queue.then(
      () => this.run(request),
      () => this.run(request),
    );
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  };

  private async run(request: SessionTitleRequest): Promise<GeneratedSessionTitle> {
    const directory = await mkdtemp(join(tmpdir(), "agent-webui-title-"));
    const schemaPath = join(directory, "schema.json");
    const outputPath = join(directory, "result.json");
    try {
      await writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA), "utf8");
      this.binaryPromise ??= resolveCodexExecutable(this.configuredBinary);
      const binary = await this.binaryPromise;
      const args = [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "--model", this.model,
        "--config", `model_reasoning_effort="${SESSION_TITLE_REASONING_EFFORT}"`,
        "--output-schema", schemaPath,
        "--output-last-message", outputPath,
        "-",
      ];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binary, args, {
          cwd: directory,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "ignore", "pipe"],
          env: { ...process.env, AGENT_WEBUI: "1", NO_COLOR: "1" },
        });
        let stderr = "";
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => {
          child.kill();
          finish(new Error(`Codex title generation timed out after ${TITLE_TIMEOUT_MS / 1000}s`));
        }, TITLE_TIMEOUT_MS);
        timer.unref?.();
        child.stderr.on("data", chunk => {
          stderr = `${stderr}${String(chunk)}`.slice(-8_192);
        });
        child.once("error", finish);
        child.once("close", code => {
          if (code === 0) finish();
          else finish(new Error(`Codex title generation exited ${code ?? "without a code"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        });
        child.stdin.end(titlerPrompt(request));
      });
      const parsed = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
      const normalized = normalizeGeneratedSessionTitle(parsed, request.text);
      if (!normalized) throw new Error("Codex returned an invalid title or emoji");
      return normalized;
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
