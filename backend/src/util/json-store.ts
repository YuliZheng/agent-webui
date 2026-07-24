import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonStore<T> {
  private value: T | undefined;
  private chain = Promise.resolve();
  constructor(public readonly path: string, private readonly fallback: () => T, private readonly normalize?: (v: unknown) => T) {}

  async get(): Promise<T> {
    if (this.value !== undefined) return structuredClone(this.value);
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      this.value = this.normalize ? this.normalize(parsed) : parsed as T;
    } catch {
      this.value = this.fallback();
    }
    return structuredClone(this.value);
  }

  async put(value: T): Promise<void> {
    const copy = structuredClone(this.normalize ? this.normalize(value) : value);
    this.value = copy;
    this.chain = this.chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      const handle = await open(tmp, "w", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(copy, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      await rename(tmp, this.path);
    });
    await this.chain;
  }

  async update(fn: (current: T) => T | void): Promise<T> {
    const current = await this.get();
    const next = fn(current) ?? current;
    await this.put(next);
    return next;
  }
}
