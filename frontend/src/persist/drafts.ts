import type { AgentKind, PendingPromptChip, PendingSessionDraft } from "@/types";
import { readJson, uid, writeJson } from "@/util/storage";
import { reactive } from "vue";

const DRAFTS_KEY = "agent-webui:text-drafts:v1";
const NEW_KEY = "agent-webui:pending-sessions:v1";
const CHIPS_KEY = "agent-webui:prompt-chips:v1";

export class DraftRepository {
  private drafts = readJson<Record<string, { text: string; editedAt: number }>>(DRAFTS_KEY, {});
  get(id: string): string { return this.drafts[id]?.text ?? ""; }
  editedAt(id: string): number { return this.drafts[id]?.editedAt ?? 0; }
  set(id: string, text: string): void {
    if (text) this.drafts[id] = { text, editedAt: Date.now() }; else delete this.drafts[id];
    writeJson(DRAFTS_KEY, this.drafts);
  }
  clearIfMatches(id: string, expectedText: string): boolean {
    if (this.get(id) !== expectedText) return false;
    delete this.drafts[id]; writeJson(DRAFTS_KEY, this.drafts); return true;
  }
}

export class PendingSessionRepository {
  items = reactive(readJson<PendingSessionDraft[]>(NEW_KEY, [])) as PendingSessionDraft[];
  create(cwd: string, agent: AgentKind): PendingSessionDraft {
    const item = { id: uid("draft"), cwd, agent, createdAt: Date.now() };
    this.items.unshift(item); this.persist(); return item;
  }
  update(id: string, patch: Partial<Pick<PendingSessionDraft, "title" | "cwd" | "agent">>): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item) { Object.assign(item, patch); this.persist(); }
  }
  remove(id: string): void { const index = this.items.findIndex((item) => item.id === id); if (index >= 0) this.items.splice(index, 1); this.persist(); }
  reconcile(cwd: string, agent: AgentKind): PendingSessionDraft | undefined {
    const item = this.items.find((candidate) => candidate.cwd === cwd && candidate.agent === agent);
    if (item) this.remove(item.id);
    return item;
  }
  private persist(): void { writeJson(NEW_KEY, this.items); }
}

export class PromptChipRepository {
  private bySession = readJson<Record<string, PendingPromptChip[]>>(CHIPS_KEY, {});
  list(id: string): PendingPromptChip[] { return this.bySession[id] ?? []; }
  add(sessionId: string, input: Omit<PendingPromptChip, "id" | "startedAt">): PendingPromptChip {
    const item = { ...input, id: uid("prompt"), startedAt: Date.now() };
    this.bySession[sessionId] = [...this.list(sessionId), item]; this.persist(); return item;
  }
  update(sessionId: string, id: string, update: Partial<PendingPromptChip>): void {
    this.bySession[sessionId] = this.list(sessionId).map((item) => item.id === id ? { ...item, ...update } : item); this.persist();
  }
  retryCandidate(sessionId: string, text: string, imageCount: number, agent: AgentKind): PendingPromptChip | undefined {
    return this.list(sessionId).find((item) => item.state === "retry" && item.agent === agent && item.imageCount === imageCount && item.text === text);
  }
  remove(sessionId: string, id: string): void {
    this.bySession[sessionId] = this.list(sessionId).filter((item) => item.id !== id); this.persist();
  }
  settleCodexSteers(sessionId: string, clientUuids: readonly string[]): PendingPromptChip[] {
    if (!clientUuids.length) return [];
    const ids = new Set(clientUuids);
    const removed = this.list(sessionId).filter((item) => item.agent === "codex" && item.steered && ids.has(item.id));
    if (!removed.length) return [];
    this.bySession[sessionId] = this.list(sessionId).filter((item) => !removed.includes(item));
    this.persist();
    return removed;
  }
  reconcileMatches(sessionId: string, text: string, index: number): PendingPromptChip[] {
    const normalized = text.trim();
    const candidates = this.list(sessionId).filter((chip) => index >= chip.startLine);
    const exact = candidates.find((chip) => chip.text.trim() === normalized);
    if (exact) { this.remove(sessionId, exact.id); return [exact]; }
    // Interrupted Codex steers are deliberately joined into one fresh turn.
    // Reconcile every oldest pending text that appears wholly in that joined
    // landing record, while keeping the reverse-containment fallback singular.
    const joined = candidates.filter((chip) => { const own = chip.text.trim(); return own.length > 8 && normalized.includes(own); });
    if (joined.length) {
      const ids = new Set(joined.map((chip) => chip.id));
      this.bySession[sessionId] = this.list(sessionId).filter((chip) => !ids.has(chip.id)); this.persist();
      return joined;
    }
    const fallback = candidates.find((chip) => { const own = chip.text.trim(); return own.length > 8 && own.includes(normalized); });
    if (fallback) this.remove(sessionId, fallback.id);
    return fallback ? [fallback] : [];
  }
  reconcile(sessionId: string, text: string, index: number): PendingPromptChip | undefined { return this.reconcileMatches(sessionId, text, index)[0]; }
  private persist(): void { writeJson(CHIPS_KEY, this.bySession); }
}

export const drafts = new DraftRepository();
export const pendingSessions = new PendingSessionRepository();
export const promptChips = new PromptChipRepository();
