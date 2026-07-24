import { afterEach, vi } from "vitest";

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

const memory = new Map<string, string>();
const storage: Storage = {
  get length() { return memory.size; },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => [...memory.keys()][index] ?? null,
  removeItem: (key) => { memory.delete(key); },
  setItem: (key, value) => { memory.set(key, String(value)); }
};
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
Object.defineProperty(window, "localStorage", { value: storage, configurable: true });

if (!(globalThis as any).crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => "00000000-0000-4000-8000-000000000000" } });
}
