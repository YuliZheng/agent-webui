import type { ColorPreference } from "./api.js";

export const MESSAGE_DISPLAY_STYLE_OPTIONS = [
  {
    value: "wechat",
    label: "WeChat",
    description: "Mobile-first chat bubbles.",
  },
  {
    value: "claude-code",
    label: "Claude Code",
    description:
      "Coding transcript with Claude Code-inspired surfaces and inline tools.",
  },
] as const;

export type MessageDisplayStyle =
  (typeof MESSAGE_DISPLAY_STYLE_OPTIONS)[number]["value"];

export interface SessionGroup {
  id: string;
  name: string;
  sessionIds: string[];
  collapsed?: boolean;
}

export interface PrefsBlob {
  version: 1;
  hiddenSessionIds: string[];
  groups: SessionGroup[];
  pinnedGroupIds: string[];
  pinnedSessionIds: string[];
  thinkingTrigger: string;
  autoCompactWindow: number | null;
  codexAutoCompactWindow: number | null;
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
  defaultCodexServiceTier: string;
  defaultCodexApprovalPreset: string;
  defaultCodexSandboxMode: string;
  showActiveSection: boolean;
  showPeerSessions: boolean;
  showSubagentSessions: boolean;
  messageDisplayStyle: MessageDisplayStyle;
  colorPreference: ColorPreference;
}

const SAFE_ID = /^[0-9A-Za-z_-]+$/;
const DEFAULT_AUTO_TITLE_FREQUENCY = 5;

export function createDefaultPrefs(): PrefsBlob {
  return {
    version: 1,
    hiddenSessionIds: [],
    groups: [],
    pinnedGroupIds: [],
    pinnedSessionIds: [],
    thinkingTrigger: "think",
    autoCompactWindow: null,
    codexAutoCompactWindow: null,
    autoTitleEnabled: true,
    autoTitleFrequency: DEFAULT_AUTO_TITLE_FREQUENCY,
    autoTitleLanguage: "auto",
    scratchSessionEnabled: false,
    scratchSessionPath: "",
    defaultClaudeModel: "deepseek-v4-pro",
    defaultClaudeEffort: "",
    defaultClaudePermissionMode: "",
    defaultCodexModel: "",
    defaultCodexEffort: "",
    defaultCodexServiceTier: "",
    defaultCodexApprovalPreset: "",
    defaultCodexSandboxMode: "",
    showActiveSection: true,
    showPeerSessions: true,
    showSubagentSessions: false,
    messageDisplayStyle: "claude-code",
    colorPreference: "system",
  };
}

export const DEFAULT_PREFS: Readonly<PrefsBlob> = Object.freeze(
  createDefaultPrefs(),
);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown, fallback: string, maxLength = 4096): string {
  return typeof value === "string" && value.length <= maxLength
    ? value
    : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function positiveSafeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : null;
}

function enumString(value: unknown, allowed: readonly string[], fallback = ""): string {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function uniqueSafeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === "string" && SAFE_ID.test(entry),
      ),
    ),
  ];
}

function normalizeGroups(value: unknown): SessionGroup[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const groups: SessionGroup[] = [];
  for (const candidate of value) {
    const group = asRecord(candidate);
    if (!group || typeof group.id !== "string" || !SAFE_ID.test(group.id)) {
      continue;
    }
    if (seen.has(group.id)) continue;
    const name = asString(group.name, "", 200).trim();
    if (!name) continue;
    seen.add(group.id);
    const normalized: SessionGroup = {
      id: group.id,
      name,
      sessionIds: uniqueSafeIds(group.sessionIds),
    };
    if (typeof group.collapsed === "boolean") {
      normalized.collapsed = group.collapsed;
    }
    groups.push(normalized);
  }
  return groups;
}

export function normalizeMessageDisplayStyle(
  value: unknown,
): MessageDisplayStyle {
  if (MESSAGE_DISPLAY_STYLE_OPTIONS.some((option) => option.value === value)) {
    return value as MessageDisplayStyle;
  }
  return "wechat";
}

export function normalizeColorPreference(value: unknown): ColorPreference {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

/**
 * Rebuilds preferences from a strict allow-list. In addition to hardening
 * corrupt files, this deliberately drops deprecated and out-of-scope fields.
 */
export function normalizePrefs(value: unknown): PrefsBlob {
  const source = asRecord(value) ?? {};
  const defaults = createDefaultPrefs();
  const rawFrequency = source.autoTitleFrequency;
  const autoTitleFrequency =
    typeof rawFrequency === "number" &&
    Number.isSafeInteger(rawFrequency) &&
    rawFrequency >= 1 &&
    rawFrequency <= 100
      ? rawFrequency
      : defaults.autoTitleFrequency;

  return {
    version: 1,
    hiddenSessionIds: uniqueSafeIds(source.hiddenSessionIds),
    groups: normalizeGroups(source.groups),
    pinnedGroupIds: uniqueSafeIds(source.pinnedGroupIds),
    pinnedSessionIds: uniqueSafeIds(source.pinnedSessionIds),
    thinkingTrigger: asString(
      source.thinkingTrigger,
      defaults.thinkingTrigger,
      200,
    ),
    autoCompactWindow: positiveSafeIntegerOrNull(source.autoCompactWindow),
    codexAutoCompactWindow: positiveSafeIntegerOrNull(
      source.codexAutoCompactWindow,
    ),
    autoTitleEnabled: asBoolean(
      source.autoTitleEnabled,
      defaults.autoTitleEnabled,
    ),
    autoTitleFrequency,
    autoTitleLanguage: asString(
      source.autoTitleLanguage,
      defaults.autoTitleLanguage,
      100,
    ),
    scratchSessionEnabled: asBoolean(
      source.scratchSessionEnabled,
      defaults.scratchSessionEnabled,
    ),
    scratchSessionPath: asString(
      source.scratchSessionPath,
      defaults.scratchSessionPath,
    ),
    defaultClaudeModel: asString(
      source.defaultClaudeModel,
      defaults.defaultClaudeModel,
      200,
    ),
    defaultClaudeEffort: asString(
      source.defaultClaudeEffort,
      defaults.defaultClaudeEffort,
      40,
    ),
    defaultClaudePermissionMode: enumString(
      source.defaultClaudePermissionMode === "default" ? "" : source.defaultClaudePermissionMode,
      ["", "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"],
    ),
    defaultCodexModel: asString(
      source.defaultCodexModel,
      defaults.defaultCodexModel,
      200,
    ),
    defaultCodexEffort: asString(
      source.defaultCodexEffort,
      defaults.defaultCodexEffort,
      40,
    ),
    defaultCodexServiceTier: enumString(
      source.defaultCodexServiceTier,
      ["", "priority"],
    ),
    defaultCodexApprovalPreset: enumString(
      source.defaultCodexApprovalPreset === "on-failure" ? "on-request" : source.defaultCodexApprovalPreset,
      ["", "untrusted", "on-request", "never"],
    ),
    defaultCodexSandboxMode: enumString(
      source.defaultCodexSandboxMode,
      ["", "read-only", "workspace-write", "danger-full-access"],
    ),
    showActiveSection: asBoolean(
      source.showActiveSection,
      defaults.showActiveSection,
    ),
    showPeerSessions: asBoolean(
      source.showPeerSessions,
      defaults.showPeerSessions,
    ),
    showSubagentSessions: asBoolean(
      source.showSubagentSessions,
      defaults.showSubagentSessions,
    ),
    messageDisplayStyle: normalizeMessageDisplayStyle(
      source.messageDisplayStyle,
    ),
    colorPreference: normalizeColorPreference(source.colorPreference),
  };
}

export function isPrefsBlob(value: unknown): value is PrefsBlob {
  const source = asRecord(value);
  if (!source) return false;
  const normalized = normalizePrefs(value);
  const expectedKeys = (Object.keys(normalized) as Array<keyof PrefsBlob>).sort();
  const actualKeys = Object.keys(source).sort();
  if (
    source.version !== 1 ||
    expectedKeys.length !== actualKeys.length ||
    !expectedKeys.every((key, index) => key === actualKeys[index])
  ) {
    return false;
  }
  return expectedKeys.every((key) => deepEqual(source[key], normalized[key]));
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => deepEqual(entry, right[index]))
    );
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && deepEqual(leftRecord[key], rightRecord[key]),
    )
  );
}
