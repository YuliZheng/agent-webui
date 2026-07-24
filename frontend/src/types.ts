export type AgentKind = "claude" | "codex";
export type MessageDisplayStyle = "wechat" | "claude-code";
export type ColorScheme = "light" | "dark" | "system";
export type ProcessStatus = "running" | "exited" | "failed";

export interface SessionListItem {
  id: string;
  cwd: string;
  mtime: string;
  size: number;
  agent: AgentKind;
  peer?: boolean;
  title?: string | null;
  titleSource?: "auto" | "manual" | null;
  titleEmoji?: string | null;
  parentSessionId?: string | null;
  status?: ProcessStatus | null;
  preview?: string | null;
  lastTurnAt?: string | null;
  lastBoundaryAt?: string | null;
  readAt?: string | null;
}

export interface IndexedRawLine { index: number; raw: string }
export interface SessionStatus { status: ProcessStatus | null; webuiAlive?: boolean; compacting?: boolean }
export interface SessionSettings { model?: string; effort?: string; permissionMode?: string; sandboxMode?: string }
export interface AgentSelectOption { value: string; label: string; description?: string | null }
export interface AgentModelOption extends AgentSelectOption {
  supportedEfforts: AgentSelectOption[];
  defaultEffort?: string | null;
  isDefault?: boolean;
}
export interface AgentCapabilities {
  agent: AgentKind;
  models: AgentModelOption[];
  permissionModes: AgentSelectOption[];
  sandboxModes: AgentSelectOption[];
  defaults: { model?: string | null; effort?: string | null; permissionMode?: string | null; sandboxMode?: string | null };
}
export interface BackgroundTask {
  id: string;
  title?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  detail?: string;
  description?: string | null;
  output?: string | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  progress?: number | null;
}
export interface Interaction {
  sessionId: string;
  requestId: string;
  kind: "permission" | "question";
  agent?: AgentKind;
  toolUseId?: string;
  title?: string;
  message?: string;
  toolName?: string;
  input?: unknown;
  command?: string | null;
  description?: string | null;
  choices?: string[];
  options?: Array<{ label: string; value: unknown }>;
  questions?: Array<{ id?: string; question: string; header?: string; options?: Array<{ label: string; description?: string | null; value?: unknown }>; multiSelect?: boolean }>;
  createdAt?: string;
}

export interface PrefsBlob {
  version: 1;
  hiddenSessionIds: string[];
  groups: Array<{ id: string; name: string; sessionIds: string[]; collapsed?: boolean }>;
  pinnedSessionIds: string[];
  pinnedGroupIds: string[];
  thinkingTrigger: string;
  autoTitleEnabled: boolean;
  autoTitleFrequency: number;
  autoTitleLanguage: string;
  scratchSessionEnabled: boolean;
  scratchSessionPath: string;
  defaultClaudeModel: string;
  defaultClaudeEffort: string;
  defaultClaudePermissionMode: string;
  defaultCodexModel: string;
  defaultCodexEffort: string;
  defaultCodexApprovalPreset: string;
  defaultCodexSandboxMode: string;
  showActiveSection: boolean;
  showPeerSessions: boolean;
  messageDisplayStyle: MessageDisplayStyle;
  colorPreference: ColorScheme;
}

export const DEFAULT_PREFS: PrefsBlob = {
  version: 1, hiddenSessionIds: [], groups: [], pinnedSessionIds: [], pinnedGroupIds: [], thinkingTrigger: "think",
  autoTitleEnabled: true, autoTitleFrequency: 5, autoTitleLanguage: "auto", scratchSessionEnabled: false, scratchSessionPath: "",
  defaultClaudeModel: "", defaultClaudeEffort: "", defaultClaudePermissionMode: "",
  defaultCodexModel: "", defaultCodexEffort: "", defaultCodexApprovalPreset: "", defaultCodexSandboxMode: "",
  showActiveSection: true,
  showPeerSessions: true, messageDisplayStyle: "claude-code", colorPreference: "system"
};

export type PushEvent = { type: string; kind?: string; [key: string]: unknown };

export interface PendingPromptChip {
  id: string;
  text: string;
  imageCount: number;
  startedAt: number;
  startLine: number;
  agent: AgentKind;
  state: "sending" | "queued" | "steered" | "retry";
  steered: boolean;
}

export interface PendingSessionDraft { id: string; cwd: string; agent: AgentKind; createdAt: number; title?: string }

export type NormalizedBlockKind =
  | "user" | "assistant" | "thinking" | "tool" | "tool-result" | "tool-run"
  | "compact-summary" | "compact-boundary" | "duration" | "api-error"
  | "local-command" | "task-notification" | "unknown";

export interface NormalizedBlock {
  key: string;
  index: number;
  sourceIndexes: number[];
  kind: NormalizedBlockKind;
  agent: AgentKind;
  text?: string;
  markdown?: string;
  uuid?: string;
  parentUuid?: string | null;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  isError?: boolean;
  sidechain?: boolean;
  agentId?: string;
  timestamp?: string;
  images?: string[];
  children?: NormalizedBlock[];
  matched?: boolean;
  meta?: Record<string, unknown>;
}
