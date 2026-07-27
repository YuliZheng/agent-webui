import { defineStore } from "pinia";

export interface PendingImage {
  id: string;
  mime: string;
  base64: string;
  dataUrl: string;
  bytes: number;
  name?: string;
}

interface State {
  bySession: Record<string, PendingImage[]>;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `img-${Date.now()}-${counter}`;
}

export const useImageDraftsStore = defineStore("imageDrafts", {
  state: (): State => ({ bySession: {} }),
  getters: {
    list: (state) => (id: string): PendingImage[] => state.bySession[id] ?? [],
    count: (state) => (id: string): number => (state.bySession[id]?.length ?? 0),
  },
  actions: {
    add(sessionId: string, item: Omit<PendingImage, "id">) {
      if (!sessionId) return;
      const arr = this.bySession[sessionId] ?? (this.bySession[sessionId] = []);
      arr.push({ ...item, id: nextId() });
    },
    remove(sessionId: string, imageId: string) {
      const arr = this.bySession[sessionId];
      if (!arr) return;
      this.bySession[sessionId] = arr.filter((i) => i.id !== imageId);
      if (this.bySession[sessionId]!.length === 0) delete this.bySession[sessionId];
    },
    // Atomically remove only the images captured by one send attempt. Images
    // attached later must remain for the next message. Returns the removed
    // items so a failed dispatched request can restore them.
    take(sessionId: string, imageIds: readonly string[]): PendingImage[] {
      const arr = this.bySession[sessionId];
      if (!arr?.length || !imageIds.length) return [];
      const wanted = new Set(imageIds);
      const removed = arr.filter((item) => wanted.has(item.id));
      const kept = arr.filter((item) => !wanted.has(item.id));
      if (kept.length) this.bySession[sessionId] = kept;
      else delete this.bySession[sessionId];
      return removed;
    },
    // Put failed-send images back ahead of any newer attachments without
    // duplicating an item that is already present.
    restore(sessionId: string, items: readonly PendingImage[]) {
      if (!sessionId || !items.length) return;
      const current = this.bySession[sessionId] ?? [];
      const existing = new Set(current.map((item) => item.id));
      const restored = items.filter((item) => !existing.has(item.id));
      if (restored.length) this.bySession[sessionId] = [...restored, ...current];
    },
    moveSession(fromId: string, toId: string) {
      if (!fromId || !toId || fromId === toId) return;
      const moved = this.bySession[fromId] ?? [];
      const current = this.bySession[toId] ?? [];
      if (moved.length) {
        const movedIds = new Set(moved.map((item) => item.id));
        this.bySession[toId] = [...moved, ...current.filter((item) => !movedIds.has(item.id))];
      }
      delete this.bySession[fromId];
    },
    clear(sessionId: string) {
      delete this.bySession[sessionId];
    },
  },
});
