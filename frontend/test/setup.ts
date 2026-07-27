// Node 25 exposes an experimental global `localStorage` placeholder when it is
// launched without a valid --localstorage-file. It has no Storage methods and
// can shadow happy-dom's implementation, so install a deterministic in-memory
// Storage for tests across supported Node releases.
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(String(key)) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(String(key)); },
    setItem(key, value) { values.set(String(key), String(value)); },
  };
}

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: memoryStorage(),
});

Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: memoryStorage(),
});
