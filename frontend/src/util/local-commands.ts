// Webui-local control commands typed in the prompt box (e.g. `/model`,
// `/context`). These are handled in the browser and NEVER sent to the agent —
// they map to existing control rails (set-model) or read already-streamed data
// (last-turn usage). This is the deliberate split Codex flagged: "prompt slash
// commands" (skills, /init …) still flow to the agent; these local control
// commands branch off before the send path.
import type {
  CliInfoTopic,
  CodexRateLimits,
  CodexRateLimitWindow,
  SkillEntry,
} from "@claude-webui/shared/api";
import { CLI_INFO_TOPICS } from "@claude-webui/shared/api";
import {
  codexVisibleMessage,
  codexVisibleMessagePriority,
  sameCodexVisibleMessage,
  type CodexVisibleMessage,
} from "@agent-webui/shared/codex";
import {
  MODEL_CHOICES,
  CODEX_APPROVAL_PRESETS,
  CODEX_MODEL_CHOICES,
  modelContextWindow,
  effectiveContextLimit,
} from "@claude-webui/shared/prefs";
import {
  clearSessionGoal,
  compactSession,
  getCliInfo,
  getCodexRateLimits,
  getSessionGoal,
  setSessionEffort,
  setSessionGoal,
  setSessionModel,
  setSessionPermissionMode,
  setSessionServiceTier,
  setSessionTitle,
  stopSession,
  type CodexGoal,
} from "../api/sessions.js";
import { copyText } from "./clipboard.js";
import { CODEX_REASONING_EFFORTS } from "./codex-efforts.js";
import { useLocalBubblesStore } from "../stores/local-bubbles.js";
import { useNotificationsStore } from "../stores/notifications.js";
import { useSessionSkillsStore } from "../stores/session-skills.js";
import { useSessionSettingsStore } from "../stores/session-settings.js";
import { useSessionsStore } from "../stores/sessions.js";
import { useUiStore } from "../stores/ui.js";

// CLI-reported built-ins that are terminal/account-only and meaningless in the
// webui (theme, login, vim mode, IDE hooks, …). Hidden from the slash menu
// (useSlashMenu) AND excluded from the forwarded-commands list (PromptInput's
// providerSlashCommandsFor), so escapeSlashCommand treats them as unknown
// (space-prepend) and they never reach the CLI.
export const HIDDEN_CLI_COMMANDS = new Set<string>([
  "background", "bg", "chrome", "color", "daemon", "design-login", "desktop",
  "app", "exit", "quit", "extra-usage", "feedback", "share", "bug", "focus",
  "heapdump", "ide", "install", "install-github-app", "install-slack-app",
  "keybindings", "login", "logout", "loops", "mobile", "ios", "android",
  "passes", "pause-memory", "powerup", "privacy-settings", "pro-trial-expired",
  "radio", "rate-limit-options", "remote-control", "remote-env", "scroll-speed",
  "session", "stickers", "teleport", "terminal-setup", "theme", "tui",
  "ultraplan", "ultrareview", "update", "upgrade", "usage-credits", "vim",
  "output-style", "voice", "web-setup", "wellbeing", "statusline",
]);

// Command → menu description. Order here is the menu order. Split by agent:
// COMMON works everywhere, CLAUDE_ONLY maps to claude control rails / the
// claude transcript exporter, CODEX_ONLY to codex driver RPCs.
const COMMON_COMMANDS = {
  model: "Switch model for this session (webui)",
  context: "Show context window usage (webui)",
  status: "Show session status (webui)",
  mcp: "Show MCP server status (webui)",
  version: "Show CLI version (webui)",
  doctor: "Run CLI health check (webui)",
  stop: "Interrupt the current turn (webui)",
  rename: "Rename this session (webui)",
  resume: "Open the session list (webui)",
  copy: "Copy the nth-latest assistant reply (webui)",
  help: "List available commands (webui)",
} as const;
const CLAUDE_ONLY_COMMANDS = {
  plan: "Enter plan mode — /plan off to leave (webui)",
  export: "Download the transcript as markdown (webui)",
  plugin: "Show installed plugins (webui)",
  hooks: "Show configured hooks (webui)",
  agents: "Show available agents (webui)",
} as const;
const CODEX_ONLY_COMMANDS = {
  effort: "Show or set reasoning effort (webui)",
  fast: "Show or toggle Fast service tier (webui)",
  permissions: "Show or set the approval preset (webui)",
  goal: "Show or update the Codex goal (webui)",
  compact: "Compact Codex context (webui)",
} as const;

type LocalCommandName =
  | keyof typeof COMMON_COMMANDS
  | keyof typeof CLAUDE_ONLY_COMMANDS
  | keyof typeof CODEX_ONLY_COMMANDS;

export interface LocalCommand {
  name: LocalCommandName;
  arg: string;
}

function commandMap(isCodex: boolean): Record<string, string> {
  return isCodex
    ? { ...COMMON_COMMANDS, ...CODEX_ONLY_COMMANDS }
    : { ...COMMON_COMMANDS, ...CLAUDE_ONLY_COMMANDS };
}

// Surfaced in the slash-command autocomplete menu alongside agent skills, so
// `/mod` / `/sta` complete to these the same way `/init` etc. do. The menu
// inserts `/<name> `; send() then routes them through parseLocalCommand.
export function localCommandEntries(isCodex: boolean): readonly SkillEntry[] {
  return Object.entries(commandMap(isCodex)).map(([name, description]) => ({ name, description }));
}

// Recognize an exact local command token only. `/model` and `/context`,
// optionally with an argument, match; `/modeling`, `/contextual`, custom skill
// commands, and ordinary prompts that merely start with `/` all return null and
// fall through to the normal agent send path.
export function parseLocalCommand(text: string, isCodex = false): LocalCommand | null {
  const names = Object.keys(commandMap(isCodex)).join("|");
  const m = new RegExp(`^/(${names})(?:\\s+([\\s\\S]*))?$`, "i").exec(text.trim());
  if (!m) return null;
  return { name: m[1]!.toLowerCase() as LocalCommandName, arg: (m[2] ?? "").trim() };
}

export interface LocalCommandCtx {
  sessionId: string;
  isCodex: boolean;
  /** Effective requested model id — drives the /context window + /model echo. */
  model: string;
  /** Latest-turn context tokens (0 if no completed turn yet). */
  ctxTokens: number;
  /** Context-window limit reported by the backend/session, if known. */
  ctxLimit?: number | null;
  /** Server-reported usage before Codex's local history estimate is added. */
  ctxReportedTokens?: number | undefined;
  /** Extra history tokens Codex estimates locally for auto-compaction. */
  ctxEstimatedTokens?: number | undefined;
  /** Approximate source mix reconstructed from the local Codex rollout. */
  ctxContributors?: readonly ContextContributor[] | undefined;
  /** Raw session jsonl/rollout lines — /copy scans these for assistant text. */
  lines?: readonly string[];
}

export interface SessionStatusRow {
  label: string;
  value: string;
}

export interface SessionStatusSummary {
  rows: SessionStatusRow[];
  /** ChatGPT plan identifier reported by Codex app-server. */
  planType: string | null;
  /** Account-level weekly allowance progress; not attributable to one session. */
  weeklyUsagePercent: number | null;
  weeklyUsageWindow: CodexRateLimitWindow | null;
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// Extract assistant reply texts (newest last) from raw session lines. Handles
// Claude records plus response, legacy-event, and item_completed Codex shapes.
export function assistantTexts(lines: readonly string[]): string[] {
  const out: string[] = [];
  let previousCodex: {
    message: CodexVisibleMessage;
    lastSourceIndex: number;
    outputIndex: number;
  } | null = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown> & {
        type?: string;
        isSidechain?: boolean;
        message?: { content?: unknown; model?: unknown };
      };
      if (rec.type === "assistant" && !rec.isSidechain && rec.message?.model !== "<synthetic>") {
        const content = rec.message?.content;
        if (Array.isArray(content)) {
          const text = content
            .filter((b): b is { type: string; text: string } =>
              !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
            .map((b) => b.text)
            .join("\n");
          if (text.trim()) out.push(text);
        }
        previousCodex = null;
        continue;
      }
      const message = codexVisibleMessage(rec);
      if (!message || message.role !== "assistant") continue;
      const previous = previousCodex;
      const isCompanion = previous !== null
        && lineIndex - previous.lastSourceIndex <= 4
        && previous.message.transport !== message.transport
        && sameCodexVisibleMessage(previous.message, message);
      if (isCompanion && previous) {
        previous.lastSourceIndex = lineIndex;
        if (codexVisibleMessagePriority(message) > codexVisibleMessagePriority(previous.message)) {
          previous.message = message;
          out[previous.outputIndex] = message.text;
        }
      } else {
        out.push(message.text);
        previousCodex = { message, lastSourceIndex: lineIndex, outputIndex: out.length - 1 };
      }
    } catch { /* skip malformed line */ }
  }
  return out;
}

function isCliInfoTopic(name: string): name is CliInfoTopic {
  return (CLI_INFO_TOPICS as readonly string[]).includes(name);
}

// /help — grouped listing of everything the composer accepts: webui-local
// commands, CLI built-ins that get forwarded (post hide-list), and skills.
function helpMarkdown(sessionId: string, isCodex: boolean): string {
  const locals = Object.entries(commandMap(isCodex))
    .map(([name, description]) => `- \`/${name}\` — ${description.replace(/ \(webui\)$/, "")}`)
    .join("\n");
  const localNames = new Set(Object.keys(commandMap(isCodex)));
  const provider = useSessionSkillsStore().list(sessionId)
    .filter((e) => !localNames.has(e.name) && !HIDDEN_CLI_COMMANDS.has(e.name.toLowerCase()));
  const isSkill = (e: SkillEntry) => e.name.includes(":") || !!e.description;
  const builtins = provider.filter((e) => !isSkill(e));
  const skills = provider.filter(isSkill);
  const fmt = (e: SkillEntry) => `- \`/${e.name}\`${e.description ? ` — ${e.description}` : ""}`;
  const sections = [
    `### Webui commands\n${locals}`,
    builtins.length ? `### CLI built-ins (forwarded to the agent)\n${builtins.map(fmt).join("\n")}` : "",
    skills.length ? `### Skills\n${skills.map(fmt).join("\n")}` : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

function fmtGoal(goal: CodexGoal): string {
  const budget = goal.tokenBudget
    ? `${fmtK(goal.tokensUsed)} / ${fmtK(goal.tokenBudget)} tokens`
    : `${fmtK(goal.tokensUsed)} tokens used`;
  return `${goal.status}: ${goal.objective}\n${budget}`;
}

function markdownCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function contextStatus(ctx: LocalCommandCtx): string {
  if (!ctx.ctxTokens) return "not reported yet";
  const limit = ctx.ctxLimit ?? modelContextWindow(ctx.model, ctx.isCodex);
  if (!limit) return `${fmtK(ctx.ctxTokens)} tokens (limit unknown)`;
  const pct = Math.round((ctx.ctxTokens / limit) * 100);
  return `${ctx.ctxEstimatedTokens ? "~" : ""}${fmtK(ctx.ctxTokens)} / ${fmtK(limit)} (${pct}%)`;
}

function percent(value: number): string {
  const rounded = Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function resetTime(value: number | null): string {
  if (value === null) return "";
  const millis = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function rateLimitValue(window: CodexRateLimitWindow): string {
  const used = Math.max(0, Math.min(100, window.usedPercent));
  const reset = resetTime(window.resetsAt);
  return `${percent(used)}% used · ${percent(100 - used)}% left${reset ? ` · resets ${reset}` : ""}`;
}

function uniqueRateLimitWindows(limits: CodexRateLimits | null): CodexRateLimitWindow[] {
  if (!limits) return [];
  const reportedWindows = [limits.primary, limits.secondary].filter(
    (window): window is CodexRateLimitWindow => window !== null,
  );
  const seenWindows = new Set<string>();
  return reportedWindows.filter((window) => {
    const key = [
      window.windowDurationMins ?? "",
      window.usedPercent,
      window.resetsAt ?? "",
    ].join(":");
    if (seenWindows.has(key)) return false;
    seenWindows.add(key);
    return true;
  });
}

function weeklyRateLimitWindow(
  limits: CodexRateLimits | null,
  windows = uniqueRateLimitWindows(limits),
): CodexRateLimitWindow | null {
  return windows.find((window) => (window.windowDurationMins ?? 0) >= 6 * 24 * 60)
    ?? limits?.secondary
    ?? null;
}

function codexRateLimitRows(limits: CodexRateLimits | null): SessionStatusRow[] {
  if (!limits) {
    return [
      { label: "5-hour usage", value: "unavailable" },
      { label: "Weekly usage", value: "unavailable" },
    ];
  }
  const windows = uniqueRateLimitWindows(limits);
  const weekly =
    weeklyRateLimitWindow(limits, windows);
  const short = windows.find((window) => window !== weekly) ?? null;
  const shortHours = short?.windowDurationMins
    ? short.windowDurationMins / 60
    : null;
  const shortLabel = shortHours && Number.isInteger(shortHours)
    ? `${shortHours}-hour usage`
    : "5-hour usage";
  return [
    ...(limits.planType ? [{ label: "Plan", value: limits.planType }] : []),
    {
      label: shortLabel,
      value: short ? rateLimitValue(short) : "not reported",
    },
    {
      label: "Weekly usage",
      value: weekly ? rateLimitValue(weekly) : "not reported",
    },
  ];
}

/**
 * Shared status model for both `/status` and the mobile three-dot sheet.
 * Keeping the data assembly here prevents the two surfaces from drifting.
 */
export async function buildSessionStatusSummary(ctx: LocalCommandCtx): Promise<SessionStatusSummary> {
  const sessions = useSessionsStore();
  const sessionSettings = useSessionSettingsStore();
  let rateLimits: CodexRateLimits | null = null;
  if (ctx.isCodex) {
    try {
      rateLimits = await getCodexRateLimits(ctx.sessionId);
    } catch {
      // Local state remains useful when account limits are unavailable.
    }
  }
  const session = sessions.byId[ctx.sessionId];
  const settings = ctx.isCodex
    ? sessionSettings.effectiveCodex(ctx.sessionId)
    : sessionSettings.effective(ctx.sessionId);
  const rawState = sessions.compactingBySession[ctx.sessionId]
    ? "compacting"
    : sessions.statusBySession[ctx.sessionId] ?? "idle";
  const state = rawState === "exited" ? "idle" : rawState;
  const weeklyWindow = weeklyRateLimitWindow(rateLimits);
  return {
    rows: [
      { label: "Agent", value: ctx.isCodex ? "Codex" : "Claude" },
      { label: "State", value: state },
      { label: "Model", value: settings.model || ctx.model || "(default)" },
      ...(ctx.isCodex
        ? [
            { label: "Reasoning effort", value: settings.effort || "(default)" },
            {
              label: "Fast",
              value: settings.serviceTier === "priority"
                ? "on"
                : settings.serviceTier === "standard" ? "off" : "unknown",
            },
            { label: "Approval preset", value: settings.permissionMode || "(default)" },
          ]
        : [{ label: "Permission mode", value: settings.permissionMode || "(default)" }]),
      { label: "Context", value: contextStatus(ctx) },
      ...(ctx.isCodex ? codexRateLimitRows(rateLimits) : []),
      { label: "Working directory", value: session?.cwd || "(unknown)" },
      { label: "Session", value: ctx.sessionId },
    ],
    planType: rateLimits?.planType ?? null,
    weeklyUsagePercent: weeklyWindow
      ? Math.max(0, Math.min(100, weeklyWindow.usedPercent))
      : null,
    weeklyUsageWindow: weeklyWindow,
  };
}

// Execute a parsed local command. Never sends anything to the agent. All
// feedback goes through the notifications (toast) store — a UI-only surface, so
// nothing pollutes the jsonl transcript or gets re-fed to the model on resume.
export async function runLocalCommand(cmd: LocalCommand, ctx: LocalCommandCtx): Promise<void> {
  const notifications = useNotificationsStore();
  const sessions = useSessionsStore();
  const sessionSettings = useSessionSettingsStore();
  const bubbles = useLocalBubblesStore();

  // /status is assembled from the same reactive state that drives the header
  // pills. Codex account limits come from its app-server, not a TUI command.
  if (cmd.name === "status") {
    if (ctx.isCodex) bubbles.begin(ctx.sessionId, "Status");
    const summary = await buildSessionStatusSummary(ctx);
    const lines = summary.rows.map(row => `- **${row.label}:** ${markdownCode(row.value)}`);
    bubbles.show(ctx.sessionId, "Status", lines.join("\n"));
    return;
  }

  // /mcp, /doctor, … — backend gathers the answer (may invoke the
  // CLI, ~10s); render the {title, markdown} result as a client-side system
  // bubble with a pending state in the meantime.
  if (isCliInfoTopic(cmd.name)) {
    const title = `/${cmd.name}`;
    bubbles.begin(ctx.sessionId, title);
    try {
      const r = await getCliInfo(ctx.sessionId, cmd.name);
      bubbles.show(ctx.sessionId, r.title, r.markdown);
    } catch (err) {
      bubbles.fail(ctx.sessionId, title, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (cmd.name === "stop") {
    try {
      await stopSession(ctx.sessionId);
      notifications.pushInfo("Interrupt sent.", { title: "Stop" });
    } catch (err) {
      notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Stop failed" });
    }
    return;
  }

  if (cmd.name === "rename") {
    if (!cmd.arg) {
      notifications.pushInfo("Usage: /rename <title>", { title: "Rename" });
      return;
    }
    try {
      const r = await setSessionTitle(ctx.sessionId, cmd.arg);
      sessions.setTitle(ctx.sessionId, r.title, r.titleSource, r.emoji);
      const displayTitle = [r.title ?? "", r.emoji ?? ""].filter(Boolean).join(" ");
      notifications.pushInfo(`Renamed to "${displayTitle}".`, { title: "Rename" });
    } catch (err) {
      notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Rename failed" });
    }
    return;
  }

  if (cmd.name === "resume") {
    // Deselect → App shows the session list (sidebar on mobile, empty-state
    // landing with recent sessions on desktop).
    useUiStore().select(null);
    return;
  }

  if (cmd.name === "copy") {
    const n = cmd.arg ? Number.parseInt(cmd.arg, 10) : 1;
    if (!Number.isFinite(n) || n < 1) {
      notifications.pushError(`Usage: /copy [n] — n counts back from the latest reply.`, { title: "Copy" });
      return;
    }
    const texts = assistantTexts(ctx.lines ?? []);
    const picked = texts[texts.length - n];
    if (!picked) {
      notifications.pushError(
        texts.length ? `Only ${texts.length} assistant repl${texts.length === 1 ? "y" : "ies"} available.` : "No assistant reply to copy yet.",
        { title: "Copy" },
      );
      return;
    }
    try {
      await copyText(picked);
      notifications.pushInfo(n === 1 ? "Latest reply copied." : `Reply #${n} from the end copied.`, { title: "Copy" });
    } catch (err) {
      notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Copy failed" });
    }
    return;
  }

  if (cmd.name === "help") {
    // Make sure the provider command/skill list is populated before listing it.
    const s = sessions.byId[ctx.sessionId];
    await useSessionSkillsStore().ensureLoaded(ctx.sessionId, {
      ...(s?.cwd ? { cwd: s.cwd } : {}),
      ...(s?.agent ? { agent: s.agent } : {}),
    });
    bubbles.show(ctx.sessionId, "Commands", helpMarkdown(ctx.sessionId, ctx.isCodex));
    return;
  }

  if (cmd.name === "export") {
    // Plain navigation triggers the browser's download flow (backend sets
    // Content-Disposition: attachment). Cookie auth rides along.
    const a = document.createElement("a");
    a.href = `/api/sessions/${encodeURIComponent(ctx.sessionId)}/export`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }

  if (cmd.name === "plan") {
    const arg = cmd.arg.toLowerCase();
    const mode = !arg ? "plan" : (arg === "off" || arg === "default") ? "default" : null;
    if (!mode) {
      notifications.pushError(`Usage: /plan [off|default]`, { title: "Plan" });
      return;
    }
    try {
      await setSessionPermissionMode(ctx.sessionId, mode);
      notifications.pushInfo(mode === "plan" ? "Plan mode on." : "Plan mode off (default permissions).", { title: "Plan" });
    } catch (err) {
      // Backend surfaces a CLI error control_response here (e.g. mode not
      // supported) — show it in the bubble per contract.
      bubbles.fail(ctx.sessionId, "/plan", err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (cmd.name === "compact") {
    if (!ctx.isCodex) return;
    try {
      await compactSession(ctx.sessionId);
      notifications.pushInfo("Compaction started.", { title: "Compact" });
    } catch (err) {
      notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Compact failed" });
    }
    return;
  }

  if (cmd.name === "effort") {
    if (!ctx.isCodex) return;
    const choices = CODEX_REASONING_EFFORTS;
    const current = sessionSettings.effective(ctx.sessionId).effort || "(default)";
    if (!cmd.arg) {
      notifications.pushInfo(
        `Current: ${current}\nUsage: /effort <level>\nOptions: ${choices.join(", ")}`,
        { title: "Reasoning effort" },
      );
      return;
    }
    const effort = cmd.arg.toLowerCase();
    if (!(choices as readonly string[]).includes(effort)) {
      notifications.pushError(`Unknown effort "${cmd.arg}".\nOptions: ${choices.join(", ")}`, { title: "Reasoning effort" });
      return;
    }
    try {
      await setSessionEffort(ctx.sessionId, effort);
      notifications.pushInfo(`Reasoning effort set to ${effort} — applies to the next turn.`, { title: "Reasoning effort" });
    } catch (err) {
      notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Set effort failed" });
    }
    return;
  }

  if (cmd.name === "fast") {
    if (!ctx.isCodex) return;
    const currentTier = sessionSettings.effectiveCodex(ctx.sessionId).serviceTier;
    const current = currentTier === "priority";
    const arg = cmd.arg.toLowerCase();
    if (!arg) {
      const label = currentTier === "priority" ? "on" : currentTier === "standard" ? "off" : "unknown";
      notifications.pushInfo(`Fast is ${label}.\nUsage: /fast <on|off>`, { title: "Fast" });
      return;
    }
    if (arg !== "on" && arg !== "off") {
      notifications.pushError("Usage: /fast <on|off>", { title: "Fast" });
      return;
    }
    const tier: "" | "priority" = arg === "on" ? "priority" : "";
    try {
      await setSessionServiceTier(ctx.sessionId, tier);
      sessionSettings.apply({ id: ctx.sessionId, serviceTier: tier || "standard" });
      notifications.pushInfo(`Fast turned ${arg} — applies from the next turn.`, { title: "Fast" });
    } catch (err) {
      notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Set Fast failed" });
    }
    return;
  }

  if (cmd.name === "permissions") {
    if (!ctx.isCodex) return;
    const choices = CODEX_APPROVAL_PRESETS.map((preset) => preset.key);
    const current = sessionSettings.effective(ctx.sessionId).permissionMode || "(default)";
    if (!cmd.arg) {
      notifications.pushInfo(
        `Current: ${current}\nUsage: /permissions <preset>\nOptions: ${choices.join(", ")}`,
        { title: "Permissions" },
      );
      return;
    }
    if (!choices.includes(cmd.arg)) {
      notifications.pushError(`Unknown preset "${cmd.arg}".\nOptions: ${choices.join(", ")}`, { title: "Permissions" });
      return;
    }
    try {
      await setSessionPermissionMode(ctx.sessionId, cmd.arg);
      notifications.pushInfo(`Approval preset set to ${cmd.arg} — applies to the next turn.`, { title: "Permissions" });
    } catch (err) {
      notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Set permissions failed" });
    }
    return;
  }

  if (cmd.name === "goal") {
    if (!ctx.isCodex) return;
    const arg = cmd.arg.trim();
    try {
      if (!arg) {
        const goal = await getSessionGoal(ctx.sessionId);
        sessions.setGoal(ctx.sessionId, goal);
        notifications.pushInfo(goal ? fmtGoal(goal) : "No goal set.\nUsage: /goal <objective>", { title: "Goal" });
        return;
      }
      const lower = arg.toLowerCase();
      if (lower === "clear") {
        await clearSessionGoal(ctx.sessionId);
        sessions.setGoal(ctx.sessionId, null);
        notifications.pushInfo("Goal cleared.", { title: "Goal" });
        return;
      }
      if (lower === "pause" || lower === "paused") {
        const goal = await setSessionGoal(ctx.sessionId, { status: "paused" });
        sessions.setGoal(ctx.sessionId, goal);
        notifications.pushInfo(fmtGoal(goal), { title: "Goal" });
        return;
      }
      if (lower === "resume" || lower === "active") {
        const goal = await setSessionGoal(ctx.sessionId, { status: "active" });
        sessions.setGoal(ctx.sessionId, goal);
        notifications.pushInfo(fmtGoal(goal), { title: "Goal" });
        return;
      }
      if (lower === "complete" || lower === "done") {
        const goal = await setSessionGoal(ctx.sessionId, { status: "complete" });
        sessions.setGoal(ctx.sessionId, goal);
        notifications.pushInfo(fmtGoal(goal), { title: "Goal" });
        return;
      }
      const goal = await setSessionGoal(ctx.sessionId, { objective: arg, status: "active" });
      sessions.setGoal(ctx.sessionId, goal);
      notifications.pushInfo(fmtGoal(goal), { title: "Goal" });
    } catch (err) {
      notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Goal failed" });
    }
    return;
  }

  if (cmd.name === "model") {
    const choices = ctx.isCodex ? CODEX_MODEL_CHOICES : MODEL_CHOICES;
    if (!cmd.arg) {
      notifications.pushInfo(
        `Current: ${ctx.model || "(default)"}\nUsage: /model <id>\nOptions: ${choices.join(", ")}`,
        { title: "Model" },
      );
      return;
    }
    // Unknown model: report locally and stop — never fall through to the agent.
    if (!(choices as readonly string[]).includes(cmd.arg)) {
      notifications.pushError(`Unknown model "${cmd.arg}".\nOptions: ${choices.join(", ")}`, { title: "Model" });
      return;
    }
    try {
      // Reuses the same control rail as the model pill (set-model →
      // control_request for claude, codex-driver.setModel for codex). Await the
      // ack before confirming so a failed switch doesn't show success.
      await setSessionModel(ctx.sessionId, cmd.arg);
      notifications.pushInfo(`Model set to ${cmd.arg} — applies to the next turn.`, { title: "Model" });
    } catch (err) {
      notifications.pushError(err instanceof Error ? err.message : String(err), { title: "Set model failed" });
    }
    return;
  }

  // /context — last-turn context occupancy. Approximate by design; we don't
  // reproduce the CLI's system/tools/memory breakdown.
  if (!ctx.ctxTokens) {
    notifications.pushInfo("No usage yet — send a turn first.", { title: "Context" });
    return;
  }
  const limit = ctx.ctxLimit ?? modelContextWindow(ctx.model, ctx.isCodex);
  if (limit) {
    const pct = Math.round((ctx.ctxTokens / limit) * 100);
    const estimate = ctx.ctxEstimatedTokens
      ? ` API reported ${fmtK(ctx.ctxReportedTokens ?? Math.max(0, ctx.ctxTokens - ctx.ctxEstimatedTokens))}; Codex adds ~${fmtK(ctx.ctxEstimatedTokens)} from local history.`
      : "";
    const sources = ctx.ctxContributors?.length
      ? ` Local source estimate: ${ctx.ctxContributors.slice(0, 4).map((item) => `${item.label} ${item.percent}%`).join(" · ")}.`
      : "";
    notifications.pushInfo(
      `${ctx.ctxEstimatedTokens ? "~" : ""}${fmtK(ctx.ctxTokens)} / ${fmtK(limit)} (${pct}%) — based on last completed turn.${estimate}${sources}`,
      { title: "Context" },
    );
  } else {
    notifications.pushInfo(
      `${fmtK(ctx.ctxTokens)} tokens used (limit unknown) — based on last completed turn.`,
      { title: "Context" },
    );
  }
}

export interface ContextUsage {
  tokens: number;
  limit: number | null;
  /** Provider-reported token total accumulated across the entire session. */
  cumulativeTokens?: number | undefined;
  reportedTokens?: number | undefined;
  estimatedTokens?: number | undefined;
  contributors?: readonly ContextContributor[] | undefined;
  /** Estimated source attribution reconciled to the cumulative thread total. */
  cumulativeContributors?: readonly ContextContributor[] | undefined;
}

export interface ContextContributor {
  source:
    | "user"
    | "assistant"
    | "agents"
    | "skills"
    | "instructions"
    | "base"
    | "compaction"
    | "images"
    | "shell"
    | "browser"
    | "patches"
    | "tools"
    | "reasoning"
    | "messages"
    | "other";
  label: string;
  tokens: number;
  percent: number;
}

export function latestContextUsage(
  lines: readonly string[],
  isCodex: boolean,
  model: string,
  autoCompactWindow: number | null = null,
  codexAutoCompactWindow: number | null = null,
): ContextUsage {
  if (isCodex) return latestCodexContextUsage(lines, codexAutoCompactWindow);
  return latestClaudeContextUsage(lines, model, autoCompactWindow);
}

export function latestClaudeContextUsage(
  lines: readonly string[],
  model: string,
  autoCompactWindow: number | null = null,
): ContextUsage {
  const limit = effectiveContextLimit(model, false, autoCompactWindow);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || (line.indexOf('"usage"') < 0 && line.indexOf('"compact_boundary"') < 0)) continue;
    try {
      const rec = JSON.parse(line) as {
        type?: string;
        subtype?: string;
        compactMetadata?: { postTokens?: unknown };
        message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
      };
      if (rec.type === "system" && rec.subtype === "compact_boundary") {
        const post = Number(rec.compactMetadata?.postTokens ?? 0);
        return { tokens: Number.isFinite(post) && post > 0 ? post : 0, limit };
      }
      const u = rec?.message?.usage;
      if (rec?.type === "assistant" && u) {
        return {
          tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          limit,
        };
      }
    } catch {
      // skip malformed line
    }
  }
  return {
    tokens: 0,
    limit,
  };
}

// Codex 0.144.x reserves 5% of the raw model window, so token_count exposes
// raw_window * 95%. Its default auto-compact limit is raw_window * 90%.
// Convert the reported usable window into the earlier practical boundary that
// actually triggers compaction. A configured cap may lower, but not raise,
// Codex's built-in 90% limit.
const CODEX_EFFECTIVE_CONTEXT_PERCENT = 95;
const CODEX_DEFAULT_AUTO_COMPACT_PERCENT = 90;

function codexAutoCompactLimit(
  modelContextWindow: number | null,
  configuredLimit: number | null,
): number | null {
  const defaultLimit = modelContextWindow && modelContextWindow > 0
    ? Math.floor((modelContextWindow * CODEX_DEFAULT_AUTO_COMPACT_PERCENT) / CODEX_EFFECTIVE_CONTEXT_PERCENT)
    : null;
  const cap = configuredLimit && Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.floor(configuredLimit)
    : null;
  if (defaultLimit === null) return cap;
  return cap === null ? defaultLimit : Math.min(defaultLimit, cap);
}

function parsedRecord(line: string | undefined): Record<string, unknown> | null {
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function responsePayload(rec: Record<string, unknown> | null): Record<string, unknown> | null {
  return rec?.type === "response_item" ? recordValue(rec.payload) : null;
}

function isCompactionRecord(rec: Record<string, unknown> | null): boolean {
  if (rec?.type === "compacted") return true;
  const payload = recordValue(rec?.payload);
  return rec?.type === "event_msg" && payload?.type === "context_compacted";
}

function estimatedReasoningTokens(encodedLength: number): number {
  const visibleBytes = Math.max(Math.floor((encodedLength * 3) / 4) - 650, 0);
  return Math.ceil(visibleBytes / 4);
}

function utf8Length(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

const CONTRIBUTOR_LABELS: Record<ContextContributor["source"], string> = {
  user: "your messages",
  assistant: "assistant replies",
  agents: "AGENTS.md",
  skills: "skills",
  instructions: "system / context",
  base: "Codex base context",
  compaction: "compaction summary",
  images: "images",
  shell: "shell",
  browser: "browser",
  patches: "patches",
  tools: "other tools",
  reasoning: "reasoning",
  messages: "other messages",
  other: "unattributed context",
};

type ContributorSource = ContextContributor["source"];
// Codex 0.144.6 replaces an inline image's base64 payload with 7,373 estimated
// model-visible bytes, then applies its four-bytes-per-token heuristic:
// ceil(7,373 / 4) = 1,844. `detail: original` can differ by dimensions, which
// cannot be recovered cheaply and synchronously for every rollout image here.
// Critically, never use the embedded base64 byte length as text tokens.
const IMAGE_CONTEXT_TOKEN_ESTIMATE = 1_844;
const MESSAGE_ENVELOPE_TOKEN_ESTIMATE = 4;
// Keep the source estimate aligned with the user's global Codex
// tool_output_token_limit. Rollouts retain full raw tool results even when
// prompt assembly truncates them.
const TOOL_OUTPUT_CONTEXT_TOKEN_LIMIT = 2_000;

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join("\n");
  const record = recordValue(value);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  if (typeof record.message === "string") return record.message;
  return record.content === undefined ? "" : messageText(record.content);
}

interface ContributorRange {
  source: "agents" | "skills";
  start: number;
  end: number;
}

function taggedRanges(
  text: string,
  source: ContributorRange["source"],
  opening: string,
  closing: string,
): ContributorRange[] {
  const ranges: ContributorRange[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(opening, cursor);
    if (start < 0) break;
    const close = text.indexOf(closing, start + opening.length);
    const end = close < 0 ? text.length : close + closing.length;
    ranges.push({ source, start, end });
    cursor = Math.max(end, start + opening.length);
  }
  return ranges;
}

function agentsInstructionRanges(text: string): ContributorRange[] {
  const ranges: ContributorRange[] = [];
  const header = /# AGENTS\.md instructions(?: for [^\r\n]+)?/gi;
  for (const match of text.matchAll(header)) {
    const start = match.index ?? 0;
    const close = text.indexOf("</INSTRUCTIONS>", start + match[0].length);
    const end = close < 0 ? text.length : close + "</INSTRUCTIONS>".length;
    ranges.push({ source: "agents", start, end });
  }
  return ranges;
}

function instructionLikeText(text: string): boolean {
  const value = text.trimStart();
  return value.startsWith("<codex_internal_context")
    || value.startsWith("<permissions instructions>")
    || value.startsWith("<collaboration_mode>")
    || value.startsWith("<multi_agent_mode>")
    || value.startsWith("<apps_instructions>")
    || value.startsWith("<plugins_instructions>")
    || value.startsWith("<environment_context>")
    || value.startsWith("<rollout_budget>");
}

function roleSource(role: unknown, text: string): ContributorSource {
  if (instructionLikeText(text)) return "instructions";
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "developer" || role === "system") return "instructions";
  return "messages";
}

function addContributorTokens(
  totals: Map<ContributorSource, number>,
  source: ContributorSource,
  tokens: number,
): void {
  if (tokens <= 0) return;
  totals.set(source, (totals.get(source) ?? 0) + tokens);
}

function addMessageContributors(
  totals: Map<ContributorSource, number>,
  payload: Record<string, unknown>,
): void {
  const text = messageText(payload.content);
  const baseSource = roleSource(payload.role, text);
  const textBytes = new TextEncoder().encode(text).length;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const imageCount = content.reduce((count, value) => {
    const block = recordValue(value);
    const type = typeof block?.type === "string" ? block.type : "";
    return count + (
      /image/i.test(type)
      || typeof block?.image_url === "string"
      || typeof block?.imageUrl === "string"
        ? 1
        : 0
    );
  }, 0);
  addContributorTokens(totals, "images", imageCount * IMAGE_CONTEXT_TOKEN_ESTIMATE);

  // Only textual content participates in the message-role split. Counting the
  // serialized payload would turn a 250 KB data URL into ~60k fake tokens.
  const tokens = Math.ceil(textBytes / 4) + MESSAGE_ENVELOPE_TOKEN_ESTIMATE;
  if (!textBytes) {
    addContributorTokens(totals, baseSource, tokens);
    return;
  }

  // AGENTS.md is injected as a user-role message. The skills catalog may share
  // one developer message with permissions/apps/plugin metadata, so account
  // for its tagged section separately and leave the remainder as instructions.
  const candidates = [
    ...agentsInstructionRanges(text),
    ...taggedRanges(text, "skills", "<skills_instructions>", "</skills_instructions>"),
  ].sort((a, b) => a.start - b.start || b.end - a.end);
  const ranges: ContributorRange[] = [];
  for (const candidate of candidates) {
    if (ranges.some((range) => candidate.start < range.end && candidate.end > range.start)) continue;
    ranges.push(candidate);
  }

  let assigned = 0;
  for (const range of ranges) {
    const sectionBytes = new TextEncoder().encode(text.slice(range.start, range.end)).length;
    const sectionTokens = Math.min(tokens - assigned, Math.round((tokens * sectionBytes) / textBytes));
    addContributorTokens(totals, range.source, sectionTokens);
    assigned += sectionTokens;
  }
  addContributorTokens(totals, baseSource, Math.max(0, tokens - assigned));
}

function contributorForTool(
  name: string,
  payload?: Record<string, unknown> | null,
): ContextContributor["source"] {
  const normalized = name.toLowerCase();
  const input = typeof payload?.input === "string"
    ? payload.input.toLowerCase()
    : typeof payload?.arguments === "string"
      ? payload.arguments.toLowerCase()
      : "";
  if (/image[_-]?(gen|generation)|imagegen/.test(normalized)
    || /image[_-]?(gen|generation)|imagegen/.test(input)) return "images";
  if (normalized === "exec") {
    if (/apply_patch|patch/.test(input)) return "patches";
    if (/browser|chrome|node_repl|playwright|computer/.test(input)) return "browser";
    if (/shell_command|exec_command|powershell/.test(input)) return "shell";
  }
  if (/apply_patch|patch/.test(normalized)) return "patches";
  if (/browser|chrome|node_repl|playwright|computer|(^|_)js$/.test(normalized)) return "browser";
  if (/shell|exec_command|shell_command|powershell/.test(normalized)) return "shell";
  return "tools";
}

type ContributorToolMap = Map<string, {
  name: string;
  source: ContextContributor["source"];
}>;

function registerContributorTool(
  tools: ContributorToolMap,
  payload: Record<string, unknown>,
): void {
  if (typeof payload.name !== "string" || /output|result/i.test(String(payload.type ?? ""))) return;
  const callId = payload.call_id ?? payload.id;
  if (typeof callId !== "string" || !callId) return;
  tools.set(callId, {
    name: payload.name,
    source: contributorForTool(payload.name, payload),
  });
}

function addPayloadContributors(
  totals: Map<ContributorSource, number>,
  tools: ContributorToolMap,
  payload: Record<string, unknown>,
): void {
  const type = typeof payload.type === "string" ? payload.type : "";
  if (!type) return;
  if (type === "message" || type === "agent_message") {
    addMessageContributors(totals, payload);
    return;
  }

  let source: ContextContributor["source"] = "other";
  let tokens = Math.ceil(utf8Length(payload) / 4);
  if (type === "reasoning" || type === "compaction") {
    source = type === "compaction" ? "compaction" : "reasoning";
    const encoded = typeof payload.encrypted_content === "string"
      ? payload.encrypted_content
      : typeof payload.encryptedContent === "string"
        ? payload.encryptedContent
        : "";
    if (encoded) tokens = estimatedReasoningTokens(encoded.length);
  } else if (type === "image_generation_call") {
    source = "images";
    tokens = Math.min(tokens, IMAGE_CONTEXT_TOKEN_ESTIMATE);
  } else if (type.includes("call") || type.includes("tool")) {
    const callId = payload.call_id ?? payload.id;
    const call = typeof callId === "string" ? tools.get(callId) : undefined;
    const toolName = typeof payload.name === "string"
      ? payload.name
      : call?.name ?? "";
    source = call?.source ?? contributorForTool(toolName, payload);
    registerContributorTool(tools, payload);
    if (/output|result/i.test(type)) {
      tokens = Math.min(tokens, TOOL_OUTPUT_CONTEXT_TOKEN_LIMIT);
    }
  }
  addContributorTokens(totals, source, Math.max(tokens, 0));
}

function addCompactionContributors(
  totals: Map<ContributorSource, number>,
  tools: ContributorToolMap,
  record: Record<string, unknown> | null,
): void {
  if (record?.type !== "compacted") return;
  const payload = recordValue(record.payload);
  if (!payload) return;
  const replacementHistory = Array.isArray(payload.replacement_history)
    ? payload.replacement_history
    : Array.isArray(payload.replacementHistory)
      ? payload.replacementHistory
      : [];
  const replacements = replacementHistory.flatMap((value) => {
    const item = recordValue(value);
    if (!item) return [];
    const replacement = item.type === "response_item"
      ? recordValue(item.payload)
      : item;
    return replacement ? [replacement] : [];
  });
  for (const replacement of replacements) registerContributorTool(tools, replacement);

  let hasEncryptedSummary = false;
  for (const replacement of replacements) {
    if (
      replacement.type === "compaction"
      && (
        typeof replacement.encrypted_content === "string"
        || typeof replacement.encryptedContent === "string"
      )
    ) {
      hasEncryptedSummary = true;
    }
    addPayloadContributors(totals, tools, replacement);
  }

  const summary = typeof payload.message === "string"
    ? payload.message
    : typeof payload.summary === "string"
      ? payload.summary
      : "";
  if (!hasEncryptedSummary && summary) {
    addContributorTokens(
      totals,
      "compaction",
      Math.ceil(new TextEncoder().encode(summary).length / 4) + MESSAGE_ENVELOPE_TOKEN_ESTIMATE,
    );
  }
}

function localHistoryContributors(
  lines: readonly string[],
  segmentStart: number,
  usageIndex: number,
  authoritativeTotal: number,
  compactionRecord: Record<string, unknown> | null = null,
): readonly ContextContributor[] {
  const toolByCallId: ContributorToolMap = new Map();
  for (let i = segmentStart; i < usageIndex; i++) {
    const payload = responsePayload(parsedRecord(lines[i]));
    if (payload) registerContributorTool(toolByCallId, payload);
  }

  const totals = new Map<ContributorSource, number>();
  addCompactionContributors(totals, toolByCallId, compactionRecord);
  for (let i = segmentStart; i < usageIndex; i++) {
    const payload = responsePayload(parsedRecord(lines[i]));
    if (payload) addPayloadContributors(totals, toolByCallId, payload);
  }

  const target = Number.isFinite(authoritativeTotal)
    ? Math.max(0, Math.floor(authoritativeTotal))
    : 0;
  if (!target) return [];

  const rawTotal = [...totals.values()].reduce((sum, tokens) => sum + tokens, 0);
  if (rawTotal < target) {
    // Rollouts do not expose a server-authored source breakdown and the WebUI
    // may only have the tail loaded. Keep all visible estimates at their honest
    // size and put the remainder in an explicit bucket instead of inflating a
    // short user message into a misleading majority share.
    totals.set("other", (totals.get("other") ?? 0) + target - rawTotal);
  } else if (rawTotal > target) {
    // Local bytes/4 estimates can exceed the server-reported context. Scale
    // down with largest remainders so the source rows still sum exactly to the
    // same value Codex `/status` displays.
    const scaled = [...totals.entries()].map(([source, tokens], index) => {
      const exact = (tokens * target) / rawTotal;
      const floor = Math.floor(exact);
      return { source, tokens: floor, remainder: exact - floor, index };
    });
    let remaining = target - scaled.reduce((sum, item) => sum + item.tokens, 0);
    for (const item of [...scaled].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
      if (remaining <= 0) break;
      item.tokens++;
      remaining--;
    }
    totals.clear();
    for (const item of scaled) {
      if (item.tokens > 0) totals.set(item.source, item.tokens);
    }
  }

  const reconciled = [...totals.entries()]
    .filter(([, tokens]) => tokens > 0)
    .map(([source, tokens], index) => {
      const exactPercent = (tokens / target) * 100;
      return {
        source,
        tokens,
        percent: Math.floor(exactPercent),
        percentRemainder: exactPercent - Math.floor(exactPercent),
        index,
      };
    });
  let percentRemaining = 100 - reconciled.reduce((sum, item) => sum + item.percent, 0);
  for (const item of [...reconciled].sort(
    (a, b) => b.percentRemainder - a.percentRemainder || a.index - b.index,
  )) {
    if (percentRemaining <= 0) break;
    item.percent++;
    percentRemaining--;
  }

  return reconciled
    .map(({ source, tokens, percent }) => ({
      source,
      label: CONTRIBUTOR_LABELS[source],
      tokens,
      percent,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

export function latestCodexContextUsage(
  lines: readonly string[],
  configuredAutoCompactLimit: number | null = null,
): ContextUsage {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const parsed = parsedRecord(line);
    if (isCompactionRecord(parsed)) {
      return {
        tokens: 0,
        limit: codexAutoCompactLimit(latestCodexContextLimit(lines, i - 1), configuredAutoCompactLimit),
      };
    }
    if (line.indexOf('"token_count"') < 0 && line.indexOf('"thread/tokenUsage/updated"') < 0) continue;
    try {
      const rec = parsed as {
        type?: string;
        payload?: {
          type?: string;
          info?: {
            last_token_usage?: {
              input_tokens?: unknown;
              output_tokens?: unknown;
              total_tokens?: unknown;
            };
            total_token_usage?: {
              total_tokens?: unknown;
            };
            model_context_window?: unknown;
          };
        };
        method?: string;
        params?: {
          tokenUsage?: {
            last?: {
              inputTokens?: unknown;
              outputTokens?: unknown;
              totalTokens?: unknown;
            };
            total?: {
              totalTokens?: unknown;
              total_tokens?: unknown;
            };
            modelContextWindow?: unknown;
          };
        };
      };
      if (rec.type === "event_msg" && rec.payload?.type === "token_count") {
        const usage = rec.payload.info?.last_token_usage;
        const reported = Number(usage?.total_tokens ?? (
          Number(usage?.input_tokens ?? 0) + Number(usage?.output_tokens ?? 0)
        ));
        const window = Number(rec.payload.info?.model_context_window ?? 0);
        const failureTotal = Number(rec.payload.info?.total_token_usage?.total_tokens);
        let segmentStart = 0;
        let compactionRecord: Record<string, unknown> | null = null;
        for (let j = i - 1; j >= 0; j--) {
          const candidate = parsedRecord(lines[j]);
          if (isCompactionRecord(candidate)) {
            segmentStart = j + 1;
            compactionRecord = candidate;
            break;
          }
        }
        // `last_token_usage.total_tokens` is the exact value Codex 0.144.6
        // uses for `/status`'s "tokens in context". Never add a second local
        // estimate to it; any source uncertainty belongs in the breakdown.
        let tokens = Number.isFinite(reported) ? Math.max(0, reported) : 0;
        const isFailureSentinel = (
          tokens === 0
          && Number.isFinite(window)
          && window > 0
          && failureTotal === window
        );
        if (isFailureSentinel) {
          tokens = window;
        }
        const cumulativeTokens = Number.isFinite(failureTotal) && failureTotal >= 0 && !isFailureSentinel
          ? failureTotal
          : undefined;
        const contributors = localHistoryContributors(
          lines,
          segmentStart,
          i,
          tokens,
          compactionRecord,
        );
        return {
          tokens,
          limit: codexAutoCompactLimit(
            Number.isFinite(window) && window > 0 ? window : null,
            configuredAutoCompactLimit,
          ),
          cumulativeTokens,
          reportedTokens: tokens,
          contributors: contributors.length ? contributors : undefined,
        };
      }
      if (rec.method === "thread/tokenUsage/updated") {
        const usage = rec.params?.tokenUsage?.last;
        const reported = Number(usage?.totalTokens ?? (
          Number(usage?.inputTokens ?? 0) + Number(usage?.outputTokens ?? 0)
        ));
        const window = Number(rec.params?.tokenUsage?.modelContextWindow ?? 0);
        const cumulative = Number(
          rec.params?.tokenUsage?.total?.totalTokens
          ?? rec.params?.tokenUsage?.total?.total_tokens,
        );
        let segmentStart = 0;
        let compactionRecord: Record<string, unknown> | null = null;
        for (let j = i - 1; j >= 0; j--) {
          const candidate = parsedRecord(lines[j]);
          if (isCompactionRecord(candidate)) {
            segmentStart = j + 1;
            compactionRecord = candidate;
            break;
          }
        }
        const tokens = Number.isFinite(reported) ? Math.max(0, reported) : 0;
        const contributors = localHistoryContributors(
          lines,
          segmentStart,
          i,
          tokens,
          compactionRecord,
        );
        return {
          tokens,
          limit: codexAutoCompactLimit(
            Number.isFinite(window) && window > 0 ? window : null,
            configuredAutoCompactLimit,
          ),
          cumulativeTokens: Number.isFinite(cumulative) && cumulative >= 0 ? cumulative : undefined,
          reportedTokens: tokens,
          contributors: contributors.length ? contributors : undefined,
        };
      }
    } catch {
      // skip malformed line
    }
  }
  return { tokens: 0, limit: null };
}

function latestCodexContextLimit(lines: readonly string[], start: number): number | null {
  for (let i = Math.min(start, lines.length - 1); i >= 0; i--) {
    const line = lines[i];
    if (!line || (line.indexOf('"model_context_window"') < 0 && line.indexOf('"modelContextWindow"') < 0)) continue;
    try {
      const rec = JSON.parse(line) as {
        payload?: { info?: { model_context_window?: unknown } };
        params?: { tokenUsage?: { modelContextWindow?: unknown } };
      };
      const n = Number(rec.payload?.info?.model_context_window ?? rec.params?.tokenUsage?.modelContextWindow ?? 0);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      // skip malformed line
    }
  }
  return null;
}

// Latest-turn context tokens = input + cache_read + cache_creation of the most
// recent assistant record carrying usage. Mirrors AssistantBlock's ctxTokens.
// Scans raw jsonl lines (claude format) from the end; returns 0 if none found.
export function latestCtxTokens(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"usage"')) continue;
    try {
      const rec = JSON.parse(line) as {
        type?: string;
        message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
      };
      const u = rec?.message?.usage;
      if (rec?.type === "assistant" && u) {
        return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
    } catch {
      // skip malformed line
    }
  }
  return 0;
}
