export type ThinkingTrigger = "" | "think" | "think hard" | "think harder" | "ultrathink";

export const MESSAGE_DISPLAY_STYLE_OPTIONS = [
  { value: "wechat", label: "WeChat", description: "Mobile-first chat bubbles." },
  { value: "claude-code", label: "Claude Code", description: "Coding transcript with Claude Code-inspired surfaces and inline tools." },
] as const;
export type MessageDisplayStyle = typeof MESSAGE_DISPLAY_STYLE_OPTIONS[number]["value"];

export function normalizeMessageDisplayStyle(v: unknown): MessageDisplayStyle {
  if (MESSAGE_DISPLAY_STYLE_OPTIONS.some((o) => o.value === v)) return v as MessageDisplayStyle;
  return "claude-code";
}

// Language the auto-titler writes session titles in. `value` is injected
// verbatim into the titler system prompt ("write the title in <value>"),
// except "auto" which is special-cased to "match the conversation's language".
// Technical terms / tickers / identifiers stay literal regardless of choice.
export const TITLE_LANGUAGE_CHOICES = [
  { value: "auto", label: "Auto (match conversation)" },
  { value: "English", label: "English" },
  { value: "简体中文", label: "简体中文 (Chinese)" },
] as const;

export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "auto",
  "dontAsk",
] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];

// Curated picker list. Free-form values are still accepted by the backend RPC;
// this list only drives the dropdown.
export const MODEL_CHOICES = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "claude-fable-5-CAVEAT[1m]",
  "claude-fable-5-CAVEAT",
  "claude-opus-4-8[1m]",
  "claude-opus-4-8",
  "claude-opus-4-7[1m]",
  "claude-opus-4-7",
  "claude-opus-4-6[1m]",
  "opus[1m]",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;

// Codex model picker list + default. Codex sessions use these instead of the
// claude MODEL_CHOICES. Default mirrors ~/.codex/config.toml's typical model.
export const CODEX_MODEL_CHOICES = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
] as const;
export const CODEX_DEFAULT_MODEL = "gpt-5.5";

// Approximate context-window size (tokens) for a model id, used by the
// `/context` readout. Anything we can't place — empty/unset, Codex, or an
// unknown id — returns null so the UI says "limit unknown" instead of
// asserting a wrong number.
//
// Window resolution, in priority order:
//   1. Explicit `[1m]` beta marker on the requested id → 1M.
//   2. Opus 4.6/4.7/4.8 → 1M. This deployment's `claude` wrapper launches these
//      with the 1M window, but the resolved id on the wire DROPS the `[1m]`
//      marker (and the jsonl persists no window field), so a bare resolved
//      `claude-opus-4-8` must still be treated as 1M — otherwise sessions
//      started outside the webui mis-report as 200K. The bare `opus` alias
//      resolves to the latest opus, also 1M.
//   3. Fable → 1M, same reasoning as opus: this deployment requests it with
//      `[1m]` but the resolved jsonl id is a bare `claude-fable-5` (observed
//      sessions exceed 200K, so the bare id must map to 1M here too). Also
//      covers the spaced "Claude Fable 5 CAVEAT" display name, which the
//      `claude-` prefix check below misses.
//   4. Other recognized Claude models (older opus, sonnet, haiku) → 200K.
export function modelContextWindow(model: string, isCodex: boolean): number | null {
  if (isCodex || !model) return null;
  if (/\[1m\]/i.test(model)) return 1_000_000;
  if (/opus-4-[678]\b/i.test(model) || /^opus\b/i.test(model)) return 1_000_000;
  if (/fable/i.test(model)) return 1_000_000;
  if (/^(claude-|opus|sonnet|haiku)/i.test(model)) return 200_000;
  return null;
}

// Effective context ceiling for the footer / usage readout: the smaller of the
// model's raw window and the CLI auto-compact window (when set). Auto-compact
// fires around this point, so it — not the model's physical capacity — is the
// practical "100%". With `autoCompactWindow` unset (null) this is just the raw
// model window, i.e. today's behaviour. Codex sessions ignore the claude CLI
// setting and keep their own window. Returns null when no limit is known.
export function effectiveContextLimit(
  model: string,
  isCodex: boolean,
  autoCompactWindow: number | null | undefined,
): number | null {
  const base = modelContextWindow(model, isCodex);
  if (isCodex || !autoCompactWindow || autoCompactWindow <= 0) return base;
  return base == null ? autoCompactWindow : Math.min(base, autoCompactWindow);
}

// Codex approval presets — mirror the codex CLI's "Update Model Permissions"
// menu (Full Access / Approve for me / Ask for approval). Each preset is an
// (approvalPolicy, sandbox) combo. The pill stores/sends the `key`; the backend
// resolves it to the two codex fields. Default = full-access (full-auto), to
// match webui claude's skip-permissions.
export interface CodexApprovalPreset {
  key: string;
  label: string;
  approvalPolicy: string;
  sandbox: string;
}
export const CODEX_APPROVAL_PRESETS: readonly CodexApprovalPreset[] = [
  { key: "full-access", label: "full-access", approvalPolicy: "never", sandbox: "danger-full-access" },
  { key: "auto", label: "auto", approvalPolicy: "on-failure", sandbox: "workspace-write" },
  { key: "ask", label: "ask", approvalPolicy: "on-request", sandbox: "workspace-write" },
  { key: "read-only", label: "read-only", approvalPolicy: "on-request", sandbox: "read-only" },
];
export const CODEX_DEFAULT_APPROVAL = "full-access";

export function codexApprovalPreset(key: string | null | undefined): CodexApprovalPreset {
  return CODEX_APPROVAL_PRESETS.find((p) => p.key === key) ?? CODEX_APPROVAL_PRESETS[0]!;
}

export interface PrefsBlob {
  hidden: string[];
  groups: Record<string, { sessions: string[] }>;
  pinned: Array<
    | { kind: "group"; name: string }
    | { kind: "session"; id: string }
  >;
  // Auto-appended to every outgoing prompt when non-empty. Triggers Claude
  // Code's extended-thinking mode at varying budgets ("think" → minimum,
  // "ultrathink" → maximum).
  thinkingTrigger: ThinkingTrigger;
  // Periodic auto-retitle: when enabled, the backend re-runs the auto-titler
  // every `autoRetitleEvery` completed turns (end_turn events) so a long
  // conversation that drifted off its original topic gets a fresher name.
  // Sessions whose title was set manually (source: "manual" in titles.json)
  // are locked and skipped — the user's name wins until they explicitly
  // click "Auto" in the rename UI to opt back in.
  autoRetitleEnabled: boolean;
  autoRetitleEvery: number;
  // Language the auto-titler writes titles in. One of TITLE_LANGUAGE_CHOICES
  // values ("auto" | "English" | "简体中文" | ...); injected into the titler
  // system prompt. Changing this only affects NEW titles — use "Re-title all"
  // to rewrite existing ones. Empty ⇒ treated as "English".
  titleLanguage: string;
  // Ad-hoc / scratch session shortcut in New Session modal. When disabled,
  // the checkbox is hidden entirely. When enabled, scratchDir overrides the
  // default `/tmp/${user}-scratch`; null falls back to that default.
  // The backend only auto-mkdirs paths under /tmp/ — anywhere else must
  // already exist or the spawn fails.
  scratchEnabled: boolean;
  scratchDir: string | null;
  // Default model passed as `--model` to new sessions and to resumes that have
  // no per-session override. Empty string means "no flag" — CLI/wrapper default
  // wins. Free-form string; the FE picker lists MODEL_CHOICES but accepts any.
  defaultModel: string;
  // Default permission mode passed as `--permission-mode` similarly. Empty
  // string means "no flag". Must be one of PERMISSION_MODES when non-empty;
  // validated by the backend put-prefs action.
  defaultPermissionMode: PermissionMode | "";
  // Defaults for new CODEX sessions, independent of claude's defaults above.
  // Empty ⇒ fall back to CODEX_DEFAULT_MODEL / CODEX_DEFAULT_APPROVAL.
  defaultCodexModel: string;
  defaultCodexEffort: string;
  defaultCodexServiceTier: "" | "priority";
  defaultCodexApproval: string;
  // Show the "● Active" pseudo-section at the top of the sidebar (running +
  // unread sessions surfaced above the normal list). When false the section
  // is hidden entirely — those sessions still appear in their normal place.
  showActiveSection: boolean;
  // Show peer sessions (call-claude / call-codex bridge workers) in the
  // sidebar. Default false — they're tooling artifacts, not real chats, so
  // they're hidden from the list. They still surface in search either way.
  showPeerSessions: boolean;
  // Codex subagent worker threads are hidden from ordinary sidebar sections by
  // default. Real forks remain visible; search and direct selection can still
  // reach a hidden subagent.
  showSubagentSessions: boolean;
  // Message-list visual presentation. Parser and underlying transcript stay
  // unchanged; the frontend switches layout/style based on this preference.
  messageDisplayStyle: MessageDisplayStyle;
  // Read-only mirror of the Claude Code CLI's auto-compact window
  // (`autoCompactWindow` in ~/.claude/settings.json; null when unset, or when
  // `autoCompactEnabled` is false). Derived by the backend from the CLI config
  // — NOT a webui-owned pref: it's overlaid on read and stripped on write, so
  // it never lands in ~/.claude-webui/prefs.json. The context footer shows
  // usage against the window the session will actually compact at, instead of
  // the model's raw capacity. See effectiveContextLimit().
  autoCompactWindow: number | null;
  // Same idea for Codex: read-only mirror of `model_auto_compact_token_limit`
  // from ~/.codex/config.toml (null when unset). Codex's context window itself
  // comes from the rollout (model_context_window); the footer shows usage
  // against min(that window, this cap).
  codexAutoCompactWindow: number | null;
}

export const EMPTY_PREFS: PrefsBlob = {
  hidden: [],
  groups: {},
  pinned: [],
  thinkingTrigger: "",
  autoRetitleEnabled: false,
  autoRetitleEvery: 10,
  titleLanguage: "English",
  scratchEnabled: true,
  scratchDir: null,
  defaultModel: "deepseek-v4-pro",
  defaultPermissionMode: "",
  defaultCodexModel: "",
  defaultCodexEffort: "",
  defaultCodexServiceTier: "",
  defaultCodexApproval: "",
  showActiveSection: true,
  showPeerSessions: false,
  showSubagentSessions: false,
  messageDisplayStyle: "claude-code",
  autoCompactWindow: null,
  codexAutoCompactWindow: null,
};
