import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePrefs, normalizeSessionSettings } from "../src/services/state.js";
import { readLocalSource } from "../src/services/files.js";
import { PreviewStore } from "../src/services/files.js";

describe("preferences and safe paths", () => {
  it("normalizes unknown styles and strips removed stacks", () => {
    const prefs = normalizePrefs({ messageDisplayStyle: "legacy", slackToken: "secret", voiceEnabled: true });
    expect(prefs.messageDisplayStyle).toBe("wechat"); expect(prefs).not.toHaveProperty("slackToken"); expect(prefs).not.toHaveProperty("voiceEnabled");
  });
  it("migrates the legacy Fast pseudo-effort to the priority service tier", () => {
    expect(normalizeSessionSettings({
      thread: { model: "gpt-5.6-sol", effort: "fast" },
      normal: { effort: "high", serviceTier: "priority" },
    })).toEqual({
      thread: { model: "gpt-5.6-sol", serviceTier: "priority" },
      normal: { effort: "high", serviceTier: "priority" },
    });
  });
  it("rejects a symlink escape after realpath", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-safe-")); const allowed = join(root, "allowed"); const outside = join(root, "outside"); await mkdir(allowed); await mkdir(outside); await writeFile(join(outside, "secret.txt"), "secret");
    try { await symlink(join(outside, "secret.txt"), join(allowed, "link.txt")); }
    catch { return; }
    await expect(readLocalSource(join(allowed, "link.txt"), [allowed])).rejects.toMatchObject({ code: 403 });
  });
  it("creates the preview root on first use", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-preview-")); const store = new PreviewStore(join(root, "missing", "previews"));
    const preview = await store.create("<!doctype html><p>safe</p>");
    expect((await store.read(preview.uuid)).toString()).toContain("safe");
  });
});
