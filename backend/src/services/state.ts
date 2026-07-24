import { join } from "node:path";
import { createDefaultPrefs, normalizePrefs, type PrefsBlob } from "@agent-webui/shared";
import { JsonStore } from "../util/json-store.js";

export { normalizePrefs } from "@agent-webui/shared";

export interface TitleEntry { title: string; source: "auto" | "manual"; emoji?: string | null; parentSessionId?: string | null }
export interface ReadEntry { at: string }
export interface SessionSetting { model?: string; effort?: string; permissionMode?: string; sandboxMode?: string }
export interface Interaction {
  sessionId: string;
  requestId: string;
  kind: "permission" | "question";
  toolName?: string;
  input?: unknown;
  questions?: unknown[];
  toolUseId?: string | null;
  command?: string | null;
  description?: string | null;
  choices?: string[];
  title?: string;
  message?: string;
  options?: Array<{ label: string; value: unknown }>;
  createdAt: string;
  agent: "claude" | "codex";
}

function objectRecord<T>(value: unknown): Record<string, T> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, T> : {};
}

export class AppState {
  readonly prefs: JsonStore<PrefsBlob>;
  readonly titles: JsonStore<Record<string, TitleEntry>>;
  readonly reads: JsonStore<Record<string, ReadEntry>>;
  readonly settings: JsonStore<Record<string, SessionSetting>>;
  readonly interactions = new Map<string, Interaction>();
  readonly tasks = new Map<string, unknown[]>();
  readonly status = new Map<string, { status: "running" | "exited" | "failed"; webuiAlive: boolean; compacting?: boolean; lastBoundaryAt?: string }>();

  constructor(stateDir: string) {
    this.prefs = new JsonStore(join(stateDir, "prefs.json"), createDefaultPrefs, normalizePrefs);
    this.titles = new JsonStore(join(stateDir, "titles.json"), () => ({}), value => objectRecord<TitleEntry>(value));
    this.reads = new JsonStore(join(stateDir, "read-state.json"), () => ({}), value => objectRecord<ReadEntry>(value));
    this.settings = new JsonStore(join(stateDir, "session-settings.json"), () => ({}), value => objectRecord<SessionSetting>(value));
  }
  interactionKey(sessionId: string, requestId: string): string { return `${sessionId}\0${requestId}`; }
}
