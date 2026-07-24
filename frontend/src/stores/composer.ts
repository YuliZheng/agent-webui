import { reactive } from "vue";
import { defineStore } from "pinia";
import type { PromptImageInput } from "@agent-webui/shared";
import type { AgentKind, PendingPromptChip } from "@/types";
import { drafts, promptChips } from "@/persist/drafts";
import { deleteAttachment, getAttachment, putAttachment } from "@/persist/session-cache";
import { mainSocket } from "@/api/ws";
import { readJson, writeJson } from "@/util/storage";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export type AttachmentRejectionReason = "too-large" | "unsupported";
export interface ComposerAttachment { id: string; file: File; objectUrl?: string; preview?: string }
export interface AttachmentAddResult { added: ComposerAttachment[]; rejected: Array<{ file: File; reason: AttachmentRejectionReason }> }
interface DraftAttachmentMeta { id: string; name: string; type: string }
const DRAFT_ATTACHMENTS_KEY = "agent-webui:draft-attachments:v1";
const draftAttachmentMeta = readJson<Record<string, DraftAttachmentMeta[]>>(DRAFT_ATTACHMENTS_KEY, {});

export function validateAttachment(file: Pick<File, "size" | "type">): AttachmentRejectionReason | null {
  if (file.size > MAX_ATTACHMENT_BYTES) return "too-large";
  return file.type.startsWith("image/") || file.type === "application/pdf" ? null : "unsupported";
}

export const useComposerStore = defineStore("composer", () => {
  const textBySession = reactive<Record<string, string>>({});
  const attachments = reactive<Record<string, ComposerAttachment[]>>({});
  const chips = reactive<Record<string, PendingPromptChip[]>>({});
  const sendingBySession = reactive<Record<string, boolean>>({});
  const restoringAttachments = new Set<string>();
  const restoredAttachments = new Set<string>();
  async function restoreDraftAttachments(sessionId: string): Promise<void> {
    restoringAttachments.add(sessionId);
    try {
      const meta = draftAttachmentMeta[sessionId] ?? [];
      const records = await Promise.all(meta.map(async item => ({ item, record: await getAttachment(draftAttachmentKey(sessionId, item.id)).catch(() => undefined) })));
      const restored = records.flatMap(({ item, record }) => {
        if (!record) return [];
        const file = new File([record.blob], item.name || record.name, { type: item.type || record.type || record.blob.type });
        const objectUrl = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
        return [{ id: item.id, file, objectUrl, preview: file.type.startsWith("image/") ? objectUrl : undefined }];
      });
      const current = attachments[sessionId] ?? [];
      const currentIds = new Set(current.map(item => item.id));
      attachments[sessionId] = [...restored.filter(item => !currentIds.has(item.id)), ...current];
      draftAttachmentMeta[sessionId] = restored.map(item => ({ id: item.id, name: item.file.name, type: item.file.type }));
      if (!draftAttachmentMeta[sessionId].length) delete draftAttachmentMeta[sessionId];
      writeJson(DRAFT_ATTACHMENTS_KEY, draftAttachmentMeta);
    } finally {
      restoringAttachments.delete(sessionId);
      restoredAttachments.add(sessionId);
    }
  }
  function ensure(id: string): void {
    if (!(id in textBySession)) textBySession[id] = drafts.get(id);
    if (!(id in chips)) chips[id] = promptChips.list(id);
    attachments[id] ??= [];
    if (!restoredAttachments.has(id) && !restoringAttachments.has(id)) void restoreDraftAttachments(id);
  }
  function setText(id: string, text: string): void { textBySession[id] = text; drafts.set(id, text); }
  function addFiles(id: string, files: FileList | File[]): AttachmentAddResult {
    const list = attachments[id] ??= [];
    const result: AttachmentAddResult = { added: [], rejected: [] };
    for (const file of Array.from(files)) {
      const reason = validateAttachment(file);
      if (reason) { result.rejected.push({ file, reason }); continue; }
      const objectUrl = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined;
      const item = { id: crypto.randomUUID(), file, objectUrl, preview: file.type.startsWith("image/") ? objectUrl : undefined };
      list.push(item); result.added.push(item);
      const meta = draftAttachmentMeta[id] ??= [];
      meta.push({ id: item.id, name: file.name, type: file.type });
      writeJson(DRAFT_ATTACHMENTS_KEY, draftAttachmentMeta);
      void putAttachment(draftAttachmentKey(id, item.id), file, file.name).catch(() => undefined);
    }
    return result;
  }
  function removeFile(id: string, attachmentId: string): void {
    const target = attachments[id]?.find((item) => item.id === attachmentId); if (target?.objectUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(target.objectUrl);
    attachments[id] = (attachments[id] ?? []).filter((item) => item.id !== attachmentId);
    draftAttachmentMeta[id] = (draftAttachmentMeta[id] ?? []).filter((item) => item.id !== attachmentId);
    if (!draftAttachmentMeta[id]?.length) delete draftAttachmentMeta[id];
    writeJson(DRAFT_ATTACHMENTS_KEY, draftAttachmentMeta);
    void deleteAttachment(draftAttachmentKey(id, attachmentId)).catch(() => undefined);
  }
  async function send(sessionId: string, agent: AgentKind, active: boolean, startLine: number): Promise<void> {
    if (sendingBySession[sessionId]) return;
    ensure(sessionId);
    const snapshot = textBySession[sessionId] ?? "";
    const files = [...(attachments[sessionId] ?? [])];
    if (!snapshot.trim() && !files.length) return;
    const nextState = agent === "codex" && active ? "steered" : agent === "claude" && active ? "queued" : "sending";
    const retry = promptChips.retryCandidate(sessionId, snapshot, files.length, agent);
    const chip = retry ?? promptChips.add(sessionId, {
      text: snapshot, imageCount: files.length, startLine, agent, steered: agent === "codex" && active, state: nextState
    });
    if (retry) promptChips.update(sessionId, chip.id, { state: nextState, steered: agent === "codex" && active });
    chips[sessionId] = promptChips.list(sessionId); sendingBySession[sessionId] = true;
    try {
      if (files.length) await persistPromptAttachments(chip.id, files);
      // Browser attachments use data URLs. Backend validates/copies them into the agent's safe attachment area.
      const images = await attachmentPayloads(files);
      await mainSocket.request("prompt", { sessionId, prompt: snapshot, images, clientUuid: chip.id }, 60_000);
      drafts.clearIfMatches(sessionId, snapshot);
      if ((textBySession[sessionId] ?? "") === snapshot) textBySession[sessionId] = "";
      clearAttachmentsIfMatches(sessionId, files);
      promptChips.update(sessionId, chip.id, { state: nextState });
    } catch (error) {
      promptChips.update(sessionId, chip.id, { state: "retry" }); throw error;
    } finally { chips[sessionId] = promptChips.list(sessionId); sendingBySession[sessionId] = false; }
  }
  function reconcile(id: string, text: string, index: number): void {
    const matched = promptChips.reconcileMatches(id, text, index);
    for (const chip of matched) void deletePromptAttachments(chip);
    chips[id] = promptChips.list(id);
  }
  function dismiss(id: string, chipId: string): void {
    const chip = promptChips.list(id).find((item) => item.id === chipId);
    promptChips.remove(id, chipId);
    if (chip) void deletePromptAttachments(chip);
    chips[id] = promptChips.list(id);
  }
  function settleCodexSteers(sessionId: string, clientUuids: readonly string[]): void {
    const settled = promptChips.settleCodexSteers(sessionId, clientUuids);
    for (const chip of settled) void deletePromptAttachments(chip);
    if (settled.length || sessionId in chips) chips[sessionId] = promptChips.list(sessionId);
  }
  async function retryChip(sessionId: string, chip: PendingPromptChip, active: boolean): Promise<void> {
    if (sendingBySession[sessionId]) return;
    const nextState = chip.agent === "codex" && active ? "steered" : chip.agent === "claude" && active ? "queued" : "sending";
    promptChips.update(sessionId, chip.id, { state: nextState, steered: chip.agent === "codex" && active });
    chips[sessionId] = promptChips.list(sessionId); sendingBySession[sessionId] = true;
    try {
      const current = attachments[sessionId] ?? [];
      const files = chip.imageCount
        ? current.length === chip.imageCount ? [...current] : await restorePromptAttachments(chip)
        : [];
      if (chip.imageCount && files.length !== chip.imageCount) throw new Error("This prompt's attachments are unavailable. Attach the files again and send from the composer.");
      const images = await attachmentPayloads(files);
      await mainSocket.request("prompt", { sessionId, prompt: chip.text, images, clientUuid: chip.id }, 60_000);
      promptChips.update(sessionId, chip.id, { state: nextState });
    } catch (error) {
      promptChips.update(sessionId, chip.id, { state: "retry" });
      throw error;
    } finally { chips[sessionId] = promptChips.list(sessionId); sendingBySession[sessionId] = false; }
  }
  function clearAttachmentsIfMatches(id: string, expected: ComposerAttachment[]): boolean {
    const current = attachments[id] ?? [];
    if (!sameAttachments(current, expected)) return false;
    for (const item of current) if (item.objectUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(item.objectUrl);
    for (const item of current) void deleteAttachment(draftAttachmentKey(id, item.id)).catch(() => undefined);
    delete draftAttachmentMeta[id]; writeJson(DRAFT_ATTACHMENTS_KEY, draftAttachmentMeta);
    attachments[id] = []; return true;
  }
  const isSending = (id: string): boolean => sendingBySession[id] === true;
  return { textBySession, attachments, chips, sendingBySession, isSending, ensure, setText, addFiles, removeFile, send, retryChip, reconcile, dismiss, settleCodexSteers, clearAttachmentsIfMatches };
});

async function fileToPayload(item: ComposerAttachment): Promise<PromptImageInput> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(item.file);
  });
  return { name: item.file.name, type: item.file.type, data };
}
export function attachmentPayloads(items: ComposerAttachment[]): Promise<PromptImageInput[]> { return Promise.all(items.map(fileToPayload)); }
export function sameAttachments(a: ComposerAttachment[], b: ComposerAttachment[]): boolean { return a.length === b.length && a.every((item, index) => item.id === b[index]?.id); }

export function promptAttachmentKey(chipId: string, index: number): string { return `prompt:${chipId}:${index}`; }
export function draftAttachmentKey(sessionId: string, attachmentId: string): string { return `draft:${sessionId}:${attachmentId}`; }
async function persistPromptAttachments(chipId: string, items: ComposerAttachment[]): Promise<void> {
  await Promise.allSettled(items.map((item, index) => putAttachment(promptAttachmentKey(chipId, index), item.file, item.file.name)));
}
async function restorePromptAttachments(chip: PendingPromptChip): Promise<ComposerAttachment[]> {
  const records = await Promise.all(Array.from({ length: chip.imageCount }, (_, index) => getAttachment(promptAttachmentKey(chip.id, index)).catch(() => undefined)));
  if (records.some((record) => !record)) return [];
  return records.map((record, index) => {
    const item = record!;
    const file = new File([item.blob], item.name, { type: item.type || item.blob.type });
    return { id: promptAttachmentKey(chip.id, index), file };
  });
}
async function deletePromptAttachments(chip: PendingPromptChip): Promise<void> {
  await Promise.allSettled(Array.from({ length: chip.imageCount }, (_, index) => deleteAttachment(promptAttachmentKey(chip.id, index))));
}
