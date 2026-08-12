import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/util/json-store.js";

describe("JsonStore serialization and recovery", () => {
  it("preserves independent concurrent read-modify-write updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-json-store-concurrent-"));
    const store = new JsonStore(join(root, "state.json"), () => ({ model: "", effort: "" }));
    await store.put({ model: "", effort: "" });

    await Promise.all([
      store.update(value => { value.model = "gpt-5"; }),
      store.update(value => { value.effort = "high"; }),
    ]);

    expect(await store.get()).toEqual({ model: "gpt-5", effort: "high" });
  });

  it("accepts later writes after a transient filesystem failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-json-store-recover-"));
    const parent = join(root, "blocked");
    await writeFile(parent, "not a directory");
    const path = join(parent, "state.json");
    const store = new JsonStore(path, () => ({ value: "fallback" }));

    await expect(store.put({ value: "first" })).rejects.toThrow();
    await unlink(parent);
    await mkdir(parent);
    await expect(store.put({ value: "second" })).resolves.toBeUndefined();

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ value: "second" });
    expect(await store.get()).toEqual({ value: "second" });
  });

  it("does not expose a snapshot whose durable write failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-json-store-rollback-"));
    const parent = join(root, "blocked");
    await writeFile(parent, "not a directory");
    const store = new JsonStore(join(parent, "state.json"), () => ({ value: "fallback" }));
    expect(await store.get()).toEqual({ value: "fallback" });

    await expect(store.put({ value: "unsaved" })).rejects.toThrow();

    expect(await store.get()).toEqual({ value: "fallback" });
  });
});
