import { access, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppState, normalizeAttachmentManifest } from "../src/services/state.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("session state and attachment cleanup", () => {
  it("persists attachment ownership and cleans only the deleted session after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-cleanup-"));
    const first = new AppState(root);
    await first.titles.put({
      deleted: { title: "old", source: "manual" },
      retained: { title: "keep", source: "auto" },
    });
    await first.reads.put({
      deleted: { at: "2026-01-01T00:00:00.000Z" },
      retained: { at: "2026-01-02T00:00:00.000Z" },
    });
    await first.settings.put({
      deleted: { model: "old" },
      retained: { model: "keep" },
    });

    const deletedBatch = await first.createAttachmentBatch();
    const retainedBatch = await first.createAttachmentBatch();
    await writeFile(join(deletedBatch.directory, "image.png"), "deleted");
    await writeFile(join(retainedBatch.directory, "image.png"), "retained");
    await Promise.all([
      first.claimAttachmentBatch(deletedBatch.batchId, "deleted"),
      first.claimAttachmentBatch(retainedBatch.batchId, "retained"),
    ]);

    const afterRestart = new AppState(root);
    await expect(afterRestart.cleanupSessions(["deleted"])).resolves.toEqual([]);

    expect(await exists(deletedBatch.directory)).toBe(false);
    expect(await exists(retainedBatch.directory)).toBe(true);
    expect(await afterRestart.titles.get()).toEqual({
      retained: { title: "keep", source: "auto" },
    });
    expect(await afterRestart.reads.get()).toEqual({
      retained: { at: "2026-01-02T00:00:00.000Z" },
    });
    expect(await afterRestart.settings.get()).toEqual({
      retained: { model: "keep" },
    });
    expect((await afterRestart.attachmentManifest.get()).sessions).toEqual({
      retained: [retainedBatch.batchId],
    });
  });

  it("tracks pending batches and removes them when a request fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-pending-"));
    const state = new AppState(root);
    const batch = await state.createAttachmentBatch();
    expect((await state.attachmentManifest.get()).pending).toHaveProperty(batch.batchId);

    await state.discardAttachmentBatch(batch.batchId);

    expect(await exists(batch.directory)).toBe(false);
    expect(await new AppState(root).attachmentManifest.get()).toEqual({
      version: 1,
      pending: {},
      sessions: {},
    });
  });

  it("reaps only stale pending batches and leaves fresh or invalid timestamps untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-stale-pending-"));
    const state = new AppState(root);
    const stale = await state.createAttachmentBatch();
    const fresh = await state.createAttachmentBatch();
    const unknownAge = await state.createAttachmentBatch();
    const now = Date.parse("2026-07-26T10:00:00.000Z");
    await state.attachmentManifest.update(manifest => {
      manifest.pending[stale.batchId]!.createdAt = "2026-07-24T09:00:00.000Z";
      manifest.pending[fresh.batchId]!.createdAt = "2026-07-26T09:30:00.000Z";
      manifest.pending[unknownAge.batchId]!.createdAt = "not-a-date";
    });

    await expect(state.cleanupStalePendingAttachments(24 * 60 * 60 * 1000, now)).resolves.toEqual([]);

    expect(await exists(stale.directory)).toBe(false);
    expect(await exists(fresh.directory)).toBe(true);
    expect(await exists(unknownAge.directory)).toBe(true);
    expect(Object.keys((await state.attachmentManifest.get()).pending).sort()).toEqual(
      [fresh.batchId, unknownAge.batchId].sort(),
    );
  });

  it("rejects an attachment-directory symlink escape and keeps it recorded for retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-attachment-safe-"));
    const outside = await mkdtemp(join(tmpdir(), "agent-webui-attachment-outside-"));
    const batchId = "11111111-1111-4111-8111-111111111111";
    await mkdir(join(root, "attachments"));
    await writeFile(join(outside, "keep.txt"), "safe");
    try {
      await symlink(outside, join(root, "attachments", batchId), "junction");
    } catch {
      return;
    }
    const state = new AppState(root);
    await state.attachmentManifest.put({
      version: 1,
      pending: {},
      sessions: { deleted: [batchId] },
    });

    const issues = await state.cleanupSessions(["deleted"]);

    expect(issues).toEqual([
      expect.objectContaining({ sessionId: "deleted", scope: "attachments" }),
    ]);
    expect(await exists(join(outside, "keep.txt"))).toBe(true);
    expect((await state.attachmentManifest.get()).sessions.deleted).toEqual([batchId]);
  });

  it("drops unsafe or malformed batch IDs while loading a manifest", () => {
    expect(normalizeAttachmentManifest({
      pending: {
        "../outside": { createdAt: "now" },
        "11111111-1111-4111-8111-111111111111": { createdAt: "now" },
      },
      sessions: {
        session: ["../outside", "11111111-1111-4111-8111-111111111111"],
      },
    })).toEqual({
      version: 1,
      pending: {
        "11111111-1111-4111-8111-111111111111": { createdAt: "now" },
      },
      sessions: {
        session: ["11111111-1111-4111-8111-111111111111"],
      },
    });
  });
});
