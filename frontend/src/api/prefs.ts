import type {
  MessageDisplayStyle,
  PrefsBlob,
  ThinkingTrigger,
} from "@claude-webui/shared/prefs";
import { EMPTY_PREFS, normalizeMessageDisplayStyle } from "@claude-webui/shared/prefs";
import { request } from "./ws.js";

type UnknownRecord = Record<string, unknown>;

interface BackendGroup {
  id: string;
  name: string;
  sessionIds: string[];
  collapsed?: boolean;
}

let lastBackendPrefs: UnknownRecord | null = null;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))]
    : [];
}

function backendGroups(value: unknown): BackendGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const group = record(item);
    const id = stringValue(group?.id).trim();
    const name = stringValue(group?.name).trim();
    if (!id || !name) return [];
    const normalized: BackendGroup = {
      id,
      name,
      sessionIds: strings(group?.sessionIds),
    };
    if (typeof group?.collapsed === "boolean") normalized.collapsed = group.collapsed;
    return [normalized];
  });
}

function thinkingTrigger(value: unknown): ThinkingTrigger {
  return value === "" ||
    value === "think" ||
    value === "think hard" ||
    value === "think harder" ||
    value === "ultrathink"
    ? value
    : "";
}

function codexApprovalFromBackend(source: UnknownRecord): string {
  const preset = stringValue(source.defaultCodexApprovalPreset);
  const sandbox = stringValue(source.defaultCodexSandboxMode);
  if (preset === "never" && sandbox === "danger-full-access") return "full-access";
  if ((preset === "on-failure" || preset === "untrusted") && sandbox === "workspace-write") return "auto";
  if (preset === "on-request" && sandbox === "read-only") return "read-only";
  if (preset === "on-request" && sandbox === "workspace-write") return "ask";
  if (preset === "full-access" || preset === "auto" || preset === "ask" || preset === "read-only") return preset;
  return stringValue(source.defaultCodexApproval);
}

/**
 * Convert the repository backend's persisted preference schema into the
 * reference frontend schema. This is deliberately the only compatibility
 * layer: UI components continue to consume the reference contracts unchanged.
 */
export function adaptBackendPrefs(value: unknown): PrefsBlob {
  const source = record(value) ?? {};
  lastBackendPrefs = { ...source };

  // Also tolerate an already-adapted blob (useful for tests and older inline
  // boot payloads) without mistaking the backend's array-based groups for it.
  const legacyGroups = record(source.groups);
  if (Array.isArray(source.hidden) && legacyGroups) {
    return {
      hidden: strings(source.hidden),
      groups: Object.fromEntries(Object.entries(legacyGroups).flatMap(([name, item]) => {
        const group = record(item);
        return group ? [[name, { sessions: strings(group.sessions) }]] : [];
      })),
      pinned: Array.isArray(source.pinned)
        ? source.pinned.reduce<PrefsBlob["pinned"]>((pins, item) => {
          const pin = record(item);
          if (pin?.kind === "session" && typeof pin.id === "string") {
            pins.push({ kind: "session", id: pin.id });
          } else if (pin?.kind === "group" && typeof pin.name === "string") {
            pins.push({ kind: "group", name: pin.name });
          }
          return pins;
        }, [])
        : [],
      thinkingTrigger: thinkingTrigger(source.thinkingTrigger),
      autoRetitleEnabled: booleanValue(source.autoRetitleEnabled, EMPTY_PREFS.autoRetitleEnabled),
      autoRetitleEvery: numberValue(source.autoRetitleEvery, EMPTY_PREFS.autoRetitleEvery),
      titleLanguage: stringValue(source.titleLanguage, EMPTY_PREFS.titleLanguage),
      scratchEnabled: booleanValue(source.scratchEnabled, EMPTY_PREFS.scratchEnabled),
      scratchDir: typeof source.scratchDir === "string" ? source.scratchDir : null,
      defaultModel: stringValue(source.defaultModel),
      defaultPermissionMode: source.defaultPermissionMode === "default"
        ? "default"
        : stringValue(source.defaultPermissionMode) as PrefsBlob["defaultPermissionMode"],
      defaultCodexModel: stringValue(source.defaultCodexModel),
      defaultCodexEffort: stringValue(source.defaultCodexEffort),
      defaultCodexServiceTier: source.defaultCodexServiceTier === "priority" ? "priority" : "",
      defaultCodexApproval: stringValue(source.defaultCodexApproval),
      showActiveSection: booleanValue(source.showActiveSection, EMPTY_PREFS.showActiveSection),
      showPeerSessions: booleanValue(source.showPeerSessions, EMPTY_PREFS.showPeerSessions),
      showSubagentSessions: booleanValue(source.showSubagentSessions, EMPTY_PREFS.showSubagentSessions),
      messageDisplayStyle: normalizeMessageDisplayStyle(source.messageDisplayStyle),
      autoCompactWindow: typeof source.autoCompactWindow === "number" ? source.autoCompactWindow : null,
      codexAutoCompactWindow: typeof source.codexAutoCompactWindow === "number" ? source.codexAutoCompactWindow : null,
    };
  }

  const groups = backendGroups(source.groups);
  const groupNames = new Map(groups.map((group) => [group.id, group.name]));
  const groupRecord: PrefsBlob["groups"] = {};
  for (const group of groups) {
    const existing = groupRecord[group.name];
    groupRecord[group.name] = {
      sessions: [...new Set([...(existing?.sessions ?? []), ...group.sessionIds])],
    };
  }

  return {
    hidden: strings(source.hiddenSessionIds),
    groups: groupRecord,
    pinned: [
      ...strings(source.pinnedGroupIds).flatMap((id) => {
        const name = groupNames.get(id);
        return name ? [{ kind: "group" as const, name }] : [];
      }),
      ...strings(source.pinnedSessionIds).map((id) => ({ kind: "session" as const, id })),
    ],
    thinkingTrigger: thinkingTrigger(source.thinkingTrigger),
    autoRetitleEnabled: booleanValue(source.autoTitleEnabled, EMPTY_PREFS.autoRetitleEnabled),
    autoRetitleEvery: numberValue(source.autoTitleFrequency, EMPTY_PREFS.autoRetitleEvery),
    titleLanguage: stringValue(source.autoTitleLanguage, EMPTY_PREFS.titleLanguage),
    scratchEnabled: booleanValue(source.scratchSessionEnabled, EMPTY_PREFS.scratchEnabled),
    scratchDir: stringValue(source.scratchSessionPath) || null,
    defaultModel: stringValue(source.defaultClaudeModel),
    defaultPermissionMode: stringValue(source.defaultClaudePermissionMode) as PrefsBlob["defaultPermissionMode"],
    defaultCodexModel: stringValue(source.defaultCodexModel),
    defaultCodexEffort: stringValue(source.defaultCodexEffort),
    defaultCodexServiceTier: source.defaultCodexServiceTier === "priority" ? "priority" : "",
    defaultCodexApproval: codexApprovalFromBackend(source),
    showActiveSection: booleanValue(source.showActiveSection, EMPTY_PREFS.showActiveSection),
    showPeerSessions: booleanValue(source.showPeerSessions, EMPTY_PREFS.showPeerSessions),
    showSubagentSessions: booleanValue(source.showSubagentSessions, EMPTY_PREFS.showSubagentSessions),
    messageDisplayStyle: normalizeMessageDisplayStyle(source.messageDisplayStyle),
    autoCompactWindow: typeof source.autoCompactWindow === "number" ? source.autoCompactWindow : null,
    codexAutoCompactWindow: typeof source.codexAutoCompactWindow === "number" ? source.codexAutoCompactWindow : null,
  };
}

function safeGroupId(name: string, used: Set<string>): string {
  let hash = 2166136261;
  for (const char of name) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const base = `g_${(hash >>> 0).toString(36)}`;
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}_${suffix++}`;
  used.add(id);
  return id;
}

function codexApprovalToBackend(value: string): {
  defaultCodexApprovalPreset: string;
  defaultCodexSandboxMode: string;
} {
  if (value === "full-access") {
    return { defaultCodexApprovalPreset: "never", defaultCodexSandboxMode: "danger-full-access" };
  }
  if (value === "auto") {
    // Current Codex app-server calls this policy `untrusted`: safe commands
    // run automatically and only commands outside its trusted set ask. The
    // reference frontend's friendly preset name remains `auto`.
    return { defaultCodexApprovalPreset: "untrusted", defaultCodexSandboxMode: "workspace-write" };
  }
  if (value === "read-only") {
    return { defaultCodexApprovalPreset: "on-request", defaultCodexSandboxMode: "read-only" };
  }
  if (value === "ask") {
    return { defaultCodexApprovalPreset: "on-request", defaultCodexSandboxMode: "workspace-write" };
  }
  return {
    defaultCodexApprovalPreset: value,
    defaultCodexSandboxMode: stringValue(lastBackendPrefs?.defaultCodexSandboxMode),
  };
}

export function adaptFrontendPrefs(blob: PrefsBlob): UnknownRecord {
  const prior = lastBackendPrefs ?? {};
  const priorGroups = backendGroups(prior.groups);
  const priorByName = new Map(priorGroups.map((group) => [group.name, group]));
  const usedIds = new Set(priorGroups.map((group) => group.id));
  const groups: BackendGroup[] = Object.entries(blob.groups).map(([name, group]) => {
    const existing = priorByName.get(name);
    return {
      id: existing?.id ?? safeGroupId(name, usedIds),
      name,
      sessionIds: [...new Set(group.sessions)],
      ...(existing?.collapsed === undefined ? {} : { collapsed: existing.collapsed }),
    };
  });
  const idByName = new Map(groups.map((group) => [group.name, group.id]));
  const codex = codexApprovalToBackend(blob.defaultCodexApproval);

  const result: UnknownRecord = {
    ...prior,
    version: 1,
    hiddenSessionIds: [...new Set(blob.hidden)],
    groups,
    pinnedGroupIds: blob.pinned.flatMap((pin) => {
      if (pin.kind !== "group") return [];
      const id = idByName.get(pin.name);
      return id ? [id] : [];
    }),
    pinnedSessionIds: blob.pinned.flatMap((pin) =>
      pin.kind === "session" ? [pin.id] : []),
    thinkingTrigger: blob.thinkingTrigger,
    autoTitleEnabled: blob.autoRetitleEnabled,
    autoTitleFrequency: blob.autoRetitleEvery,
    autoTitleLanguage: blob.titleLanguage,
    scratchSessionEnabled: blob.scratchEnabled,
    scratchSessionPath: blob.scratchDir ?? "",
    defaultClaudeModel: blob.defaultModel,
    defaultClaudePermissionMode: blob.defaultPermissionMode === "default" ? "" : blob.defaultPermissionMode,
    defaultCodexModel: blob.defaultCodexModel,
    defaultCodexEffort: blob.defaultCodexEffort,
    defaultCodexServiceTier: blob.defaultCodexServiceTier,
    ...codex,
    showActiveSection: blob.showActiveSection,
    showPeerSessions: blob.showPeerSessions,
    showSubagentSessions: blob.showSubagentSessions,
    messageDisplayStyle: blob.messageDisplayStyle as MessageDisplayStyle,
  };
  // These are read-only mirrors used by the frontend's context display. Older
  // WebUI builds persisted manual overrides, so spreading `prior` above can
  // otherwise resurrect a stale value on every unrelated preference save.
  delete result.autoCompactWindow;
  delete result.codexAutoCompactWindow;
  lastBackendPrefs = { ...result };
  return result;
}

export async function getPrefs(): Promise<PrefsBlob> {
  return adaptBackendPrefs(await request<unknown>("get-prefs"));
}

export async function putPrefs(blob: PrefsBlob): Promise<void> {
  await request("put-prefs", { prefs: adaptFrontendPrefs(blob) });
}
