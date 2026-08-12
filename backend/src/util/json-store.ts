import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonStore<T> {
  private value: T | undefined;
  private chain = Promise.resolve();
  constructor(public readonly path: string, private readonly fallback: () => T, private readonly normalize?: (v: unknown) => T) {}

  private async load(): Promise<T> {
    if (this.value !== undefined) return structuredClone(this.value);
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      this.value = this.normalize ? this.normalize(parsed) : parsed as T;
    } catch {
      this.value = this.fallback();
    }
    return structuredClone(this.value);
  }

  private enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.chain.then(operation);
    // A transient write failure must reject that caller without poisoning every
    // later read/write for the lifetime of the process.
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(copy: T): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(copy, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(tmp, this.path);
  }

  async get(): Promise<T> {
    return this.enqueue(() => this.load());
  }

  async put(value: T): Promise<void> {
    const copy = structuredClone(this.normalize ? this.normalize(value) : value);
    await this.enqueue(async () => {
      await this.persist(copy);
      // Publish the new in-memory snapshot only after the durable atomic rename
      // succeeds, so a failed write cannot make reads observe unsaved state.
      this.value = copy;
    });
  }

  async update(fn: (current: T) => T | void): Promise<T> {
    return this.enqueue(async () => {
      // Keep the complete read-modify-write cycle inside the same queue slot.
      // Serializing only persist() lets concurrent field updates start from the
      // same stale snapshot and overwrite one another.
      const current = await this.load();
      const next = fn(current) ?? current;
      const copy = structuredClone(this.normalize ? this.normalize(next) : next);
      await this.persist(copy);
      this.value = copy;
      return structuredClone(copy);
    });
  }
}
