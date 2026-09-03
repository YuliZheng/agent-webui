import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDefaultPrefs, normalizePrefs, type PrefsBlob } from "@agent-webui/shared";
import { JsonStore } from "../util/json-store.js";
import { isWithin } from "../util/paths.js";
import type { SessionTitleGenerator } from "./session-title-generator.js";

export { normalizePrefs } from "@agent-webui/shared";

export interface TitleEntry {
  title: string;
  source: "auto" | "manual";
  emoji?: string | null;
  parentSessionId?: string | null;
  /** Hidden rolling context used by the automatic title generator. */
  topicSummary?: string;
}
export interface ReadEntry {
  at?: string;
  /** Latest completed assistant turn accounted for in unreadCount. */
  unreadAt?: string;
  /** Global unread assistant-turn count shared by every client. */
  unreadCount?: number;
}
export interface SessionSetting {
  model?: string;
  effort?: string;
  serviceTier?: string;
  permissionMode?: string;
  sandboxMode?: string;
}
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

export interface AttachmentManifest {
  version: 1;
  pending: Record<string, { createdAt: string }>;
  sessions: Record<string, string[]>;
}

export interface SessionCleanupIssue {
  sessionId: string;
  scope: "titles" | "reads" | "settings" | "attachments";
  message: string;
}

export interface PendingAttachmentCleanupIssue {
  batchId: string;
  message: string;
}

const ATTACHMENT_BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DEFAULT_PENDING_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function objectRecord<T>(value: unknown): Record<string, T> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, T> : {};
}

function emptyAttachmentManifest(): AttachmentManifest {
  return { version: 1, pending: {}, sessions: {} };
}

export function normalizeAttachmentManifest(value: unknown): AttachmentManifest {
  const raw = objectRecord<unknown>(value);
  const pending: AttachmentManifest["pending"] = {};
  for (const [batchId, entry] of Object.entries(objectRecord<unknown>(raw.pending))) {
    if (!ATTACHMENT_BATCH_ID.test(batchId)) continue;
    const createdAt = objectRecord<unknown>(entry).createdAt;
    if (typeof createdAt === "string") pending[batchId] = { createdAt };
  }
  const sessions: AttachmentManifest["sessions"] = {};
  for (const [sessionId, entries] of Object.entries(objectRecord<unknown>(raw.sessions))) {
    if (!Array.isArray(entries)) continue;
    const batchIds = [...new Set(entries.filter((entry): entry is string =>
      typeof entry === "string" && ATTACHMENT_BATCH_ID.test(entry),
    ))];
    if (batchIds.length) sessions[sessionId] = batchIds;
  }
  return { version: 1, pending, sessions };
}

export function normalizeSessionSettings(value: unknown): Record<string, SessionSetting> {
  const rows = objectRecord<unknown>(value);
  const normalized: Record<string, SessionSetting> = {};
  for (const [id, entry] of Object.entries(rows)) {
    const raw = objectRecord<unknown>(entry);
    const setting: SessionSetting = {};
    for (const key of ["model", "permissionMode", "sandboxMode"] as const) {
      if (typeof raw[key] === "string" && raw[key].trim()) setting[key] = raw[key].trim();
    }
    // Older WebUI builds represented the Fast service tier as a fake
    // reasoning effort. Codex rejects effort="fast" with HTTP 400, so migrate
    // it in memory before any resumed prompt can inherit the stale value.
    if (raw.effort === "fast") {
      setting.serviceTier = typeof raw.serviceTier === "string" && raw.serviceTier.trim()
        ? raw.serviceTier.trim()
        : "priority";
    } else if (typeof raw.effort === "string" && raw.effort.trim()) {
      setting.effort = raw.effort.trim();
    }
    if (raw.serviceTier === "priority" || raw.serviceTier === "standard") {
      setting.serviceTier = raw.serviceTier;
    }
    normalized[id] = setting;
  }
  return normalized;
}

export class AppState {
  readonly prefs: JsonStore<PrefsBlob>;
  readonly titles: JsonStore<Record<string, TitleEntry>>;
  readonly reads: JsonStore<Record<string, ReadEntry>>;
  readonly settings: JsonStore<Record<string, SessionSetting>>;
  readonly attachmentManifest: JsonStore<AttachmentManifest>;
  readonly interactions = new Map<string, Interaction>();
  readonly tasks = new Map<string, unknown[]>();
  readonly status = new Map<string, { status: "running" | "exited" | "failed"; webuiAlive: boolean; compacting?: boolean; lastBoundaryAt?: string }>();
  readonly capacityRetries = new Map<string, {
    turnId: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    retryAt: string;
  }>();
  readonly attachmentRoot: string;
  private attachmentChain = Promise.resolve();

  claudeBinary?: string;
  titleGenerator?: SessionTitleGenerator;

  constructor(readonly stateDir: string) {
    this.stateDir = resolve(stateDir);
    this.attachmentRoot = join(this.stateDir, "attachments");
    this.prefs = new JsonStore(join(this.stateDir, "prefs.json"), createDefaultPrefs, normalizePrefs);
    this.titles = new JsonStore(join(this.stateDir, "titles.json"), () => ({}), value => objectRecord<TitleEntry>(value));
    this.reads = new JsonStore(join(this.stateDir, "read-state.json"), () => ({}), value => objectRecord<ReadEntry>(value));
    this.settings = new JsonStore(join(this.stateDir, "session-settings.json"), () => ({}), normalizeSessionSettings);
    this.attachmentManifest = new JsonStore(
      join(this.stateDir, "attachment-manifest.json"),
      emptyAttachmentManifest,
      normalizeAttachmentManifest,
    );
  }

  interactionKey(sessionId: string, requestId: string): string { return `${sessionId}\0${requestId}`; }

  async createAttachmentBatch(): Promise<{ batchId: string; directory: string }> {
    await mkdir(this.attachmentRoot, { recursive: true, mode: 0o700 });
    const [actualStateDir, actualRoot] = await Promise.all([
      realpath(this.stateDir),
      realpath(this.attachmentRoot),
    ]);
    if (actualRoot === actualStateDir || !isWithin(actualStateDir, actualRoot)) {
      throw new Error("Unsafe attachment root");
    }

    const batchId = randomUUID();
    const directory = join(this.attachmentRoot, batchId);
    await mkdir(directory, { mode: 0o700 });
    try {
      const actualDirectory = await realpath(directory);
      if (actualDirectory === actualRoot || !isWithin(actualRoot, actualDirectory)) {
        throw new Error("Unsafe attachment directory");
      }
      await this.updateAttachmentManifest(manifest => {
        manifest.pending[batchId] = { createdAt: new Date().toISOString() };
      });
      return { batchId, directory: actualDirectory };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async claimAttachmentBatch(batchId: string, sessionId: string): Promise<void> {
    this.assertAttachmentBatchId(batchId);
    const [actualRoot, actualDirectory] = await Promise.all([
      realpath(this.attachmentRoot),
      realpath(join(this.attachmentRoot, batchId)),
    ]);
    if (actualDirectory === actualRoot || !isWithin(actualRoot, actualDirectory)) {
      throw new Error("Unsafe attachment directory");
    }
    await this.updateAttachmentManifest(manifest => {
      delete manifest.pending[batchId];
      const batches = manifest.sessions[sessionId] ?? [];
      if (!batches.includes(batchId)) batches.push(batchId);
      manifest.sessions[sessionId] = batches;
    });
  }

  async discardAttachmentBatch(batchId: string): Promise<void> {
    this.assertAttachmentBatchId(batchId);
    await this.serializeAttachmentOperation(async () => {
      await this.removeAttachmentDirectory(batchId);
      await this.attachmentManifest.update(manifest => {
        delete manifest.pending[batchId];
        for (const [sessionId, batches] of Object.entries(manifest.sessions)) {
          const remaining = batches.filter(value => value !== batchId);
          if (remaining.length) manifest.sessions[sessionId] = remaining;
          else delete manifest.sessions[sessionId];
        }
      });
    });
  }

  async cleanupSessions(sessionIds: readonly string[]): Promise<SessionCleanupIssue[]> {
    const ids = [...new Set(sessionIds)];
    const issues: SessionCleanupIssue[] = [];
    const scrub = async <T>(
      scope: SessionCleanupIssue["scope"],
      store: JsonStore<Record<string, T>>,
    ) => {
      try {
        await store.update(entries => {
          for (const id of ids) delete entries[id];
        });
      } catch (error) {
        for (const sessionId of ids) {
          issues.push({ sessionId, scope, message: error instanceof Error ? error.message : "Cleanup failed" });
        }
      }
    };
    await Promise.all([
      scrub("titles", this.titles),
      scrub("reads", this.reads),
      scrub("settings", this.settings),
    ]);

    const manifest = await this.attachmentManifest.get();
    for (const sessionId of ids) {
      for (const batchId of manifest.sessions[sessionId] ?? []) {
        try {
          await this.discardAttachmentBatch(batchId);
        } catch (error) {
          issues.push({
            sessionId,
            scope: "attachments",
            message: error instanceof Error ? error.message : "Attachment cleanup failed",
          });
        }
      }
    }
    return issues;
  }

  async cleanupStalePendingAttachments(
    maxAgeMs = DEFAULT_PENDING_ATTACHMENT_MAX_AGE_MS,
    now = Date.now(),
  ): Promise<PendingAttachmentCleanupIssue[]> {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error("Invalid pending attachment age");
    const failures: PendingAttachmentCleanupIssue[] = [];
    const manifest = await this.attachmentManifest.get();
    for (const [batchId, pending] of Object.entries(manifest.pending)) {
      const createdAt = Date.parse(pending.createdAt);
      // An invalid or future timestamp is retained: stale cleanup must always
      // prefer a small leak over deleting a batch another instance may use.
      if (!Number.isFinite(createdAt) || createdAt > now || now - createdAt < maxAgeMs) continue;
      try {
        await this.discardAttachmentBatch(batchId);
      } catch (error) {
        failures.push({
          batchId,
          message: error instanceof Error ? error.message : "Pending attachment cleanup failed",
        });
      }
    }
    return failures;
  }

  private assertAttachmentBatchId(batchId: string): void {
    if (!ATTACHMENT_BATCH_ID.test(batchId)) throw new Error("Invalid attachment batch ID");
  }

  private async updateAttachmentManifest(update: (manifest: AttachmentManifest) => void): Promise<void> {
    await this.serializeAttachmentOperation(async () => {
      await this.attachmentManifest.update(update);
    });
  }

  private async serializeAttachmentOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.attachmentChain.then(operation);
    this.attachmentChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async removeAttachmentDirectory(batchId: string): Promise<void> {
    const directory = join(this.attachmentRoot, batchId);
    let actualStateDir: string;
    let actualRoot: string;
    let actualDirectory: string;
    try {
      [actualStateDir, actualRoot, actualDirectory] = await Promise.all([
        realpath(this.stateDir),
        realpath(this.attachmentRoot),
        realpath(directory),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      actualRoot === actualStateDir
      || !isWithin(actualStateDir, actualRoot)
      || actualDirectory === actualRoot
      || !isWithin(actualRoot, actualDirectory)
    ) {
      throw new Error("Unsafe attachment directory");
    }
    await rm(directory, { recursive: true, force: true });
  }
}
