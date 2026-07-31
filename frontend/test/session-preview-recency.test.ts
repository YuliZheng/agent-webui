import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionListItem } from "@claude-webui/shared/api";
import { useSessionsStore } from "../src/stores/sessions.js";

const sessionRow = readFileSync(
  join(process.cwd(), "src/components/SessionRow.vue"),
  "utf8",
);

function session(
  preview: string,
  mtime: string,
  lastTurnAt = mtime,
  id = "session",
): SessionListItem {
  return {
    id,
    cwd: "C:\\work",
    mtime,
    size: preview.length,
    title: null,
    parentSessionId: null,
    preview,
    lastTurnAt,
  };
}

describe("sidebar preview recency", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("does not let an older touched event replace a newer preview", () => {
    const store = useSessionsStore();
    store.addOrTouch(session("newest message", "2026-07-30T01:00:02.000Z"));
    store.addOrTouch(session("older message", "2026-07-30T01:00:01.000Z"));

    expect(store.byId.session?.preview).toBe("newest message");
    expect(store.byId.session?.mtime).toBe("2026-07-30T01:00:02.000Z");
  });

  it("shows a durable latest message instead of hiding it behind running status", () => {
    const previewIndex = sessionRow.indexOf(
      'if (preview.value) return { text: preview.value, kind: "preview" };',
    );
    const runningIndex = sessionRow.indexOf("if (isRunning.value) {");

    expect(previewIndex).toBeGreaterThan(-1);
    expect(runningIndex).toBeGreaterThan(previewIndex);
  });

  it("uses file size to order touched events with the same mtime", () => {
    const store = useSessionsStore();
    store.addOrTouch({
      ...session("newest same-tick message", "2026-07-30T01:00:02.000Z"),
      size: 200,
    });
    store.addOrTouch({
      ...session("older same-tick message", "2026-07-30T01:00:02.000Z"),
      size: 100,
    });

    expect(store.byId.session?.preview).toBe("newest same-tick message");
    expect(store.byId.session?.size).toBe(200);
  });

  it("upgrades a synthetic empty row with authoritative file metadata", () => {
    const store = useSessionsStore();
    store.addOrTouch({
      ...session("", "2026-07-30T01:00:02.000Z"),
      size: 0,
      preview: null,
    });
    store.addOrTouch(session(
      "first persisted message",
      "2026-07-30T01:00:01.999Z",
    ));

    expect(store.byId.session?.preview).toBe("first persisted message");
    expect(store.byId.session?.size).toBeGreaterThan(0);
    expect(store.byId.session?.mtime).toBe("2026-07-30T01:00:01.999Z");
  });

  it("preserves live metadata that arrived after a list request started", () => {
    const store = useSessionsStore();
    store.hydrateList([
      session("initial message", "2026-07-30T01:00:00.000Z"),
    ]);
    const requestRevision = store.metadataRevision;
    store.addOrTouch(session("live latest message", "2026-07-30T01:00:02.000Z"));

    store.hydrateList([
      // Same file mtime is possible when the list snapshot and touched event
      // race within the filesystem timestamp resolution.
      session(
        "stale list message",
        "2026-07-30T01:00:02.000Z",
        "2026-07-30T01:00:01.000Z",
      ),
    ], requestRevision);

    expect(store.byId.session?.preview).toBe("live latest message");
    expect(store.byId.session?.lastTurnAt).toBe("2026-07-30T01:00:02.000Z");
  });

  it("keeps a live-added row missing from an older list snapshot", () => {
    const store = useSessionsStore();
    const requestRevision = store.metadataRevision;
    store.addOrTouch(session(
      "new session message",
      "2026-07-30T01:00:02.000Z",
      undefined,
      "new-session",
    ));

    store.hydrateList([], requestRevision);

    expect(store.byId["new-session"]?.preview).toBe("new session message");
  });

  it("does not resurrect a row deleted after a list request started", () => {
    const store = useSessionsStore();
    store.hydrateList([
      session("to be deleted", "2026-07-30T01:00:00.000Z"),
    ]);
    const requestRevision = store.metadataRevision;
    store.removeMany(["session"]);

    store.hydrateList([
      session("stale response", "2026-07-30T01:00:00.000Z"),
    ], requestRevision);

    expect(store.byId.session).toBeUndefined();
  });

  it("accepts an intentional rewrite with a newer file mtime", () => {
    const store = useSessionsStore();
    store.addOrTouch(session(
      "message before rewind",
      "2026-07-30T01:00:01.000Z",
      "2026-07-30T01:00:01.000Z",
    ));
    store.addOrTouch(session(
      "latest message after rewind",
      "2026-07-30T01:00:03.000Z",
      "2026-07-29T23:00:00.000Z",
    ));

    expect(store.byId.session?.preview).toBe("latest message after rewind");
    expect(store.byId.session?.lastTurnAt).toBe("2026-07-29T23:00:00.000Z");
  });
});
