import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const attachmentRecords = vi.hoisted(() => new Map<string, { id: string; blob: Blob; name: string; type: string }>());

vi.mock("@/persist/session-cache", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/persist/session-cache")>();
  return {
    ...original,
    putAttachment: async (id: string, blob: Blob, name: string) => {
      attachmentRecords.set(id, { id, blob, name, type: blob.type });
    },
    getAttachment: async (id: string) => attachmentRecords.get(id),
    deleteAttachment: async (id: string) => { attachmentRecords.delete(id); },
  };
});

import { draftAttachmentKey, useComposerStore } from "@/stores/composer";

beforeEach(() => {
  localStorage.clear();
  attachmentRecords.clear();
  setActivePinia(createPinia());
});

describe("unsent draft attachments", () => {
  it("restores the file from IndexedDB metadata after the store is recreated", async () => {
    const first = useComposerStore();
    const file = new File(["image"], "paste.png", { type: "image/png" });
    const added = first.addFiles("session-draft", [file]).added[0]!;
    await vi.waitFor(() => expect(attachmentRecords.has(draftAttachmentKey("session-draft", added.id))).toBe(true));

    setActivePinia(createPinia());
    const restored = useComposerStore();
    restored.ensure("session-draft");
    await vi.waitFor(() => expect(restored.attachments["session-draft"]).toHaveLength(1));
    expect(restored.attachments["session-draft"]?.[0]?.file.name).toBe("paste.png");
    expect(restored.attachments["session-draft"]?.[0]?.file.type).toBe("image/png");

    restored.removeFile("session-draft", added.id);
    await vi.waitFor(() => expect(attachmentRecords.has(draftAttachmentKey("session-draft", added.id))).toBe(false));
  });
});
