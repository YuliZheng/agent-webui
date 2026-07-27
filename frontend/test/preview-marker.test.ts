import { describe, it, expect } from "vitest";
import { extractPreviewMarker, groupTimeline, type TimelineNode } from "../src/parser/group.js";

const VALID_PATH = "/preview/12345678-1234-1234-1234-123456789abc/index.html";

describe("extractPreviewMarker", () => {
  it("extracts summary and path from a marker line in string payload", () => {
    const text = `__CWUI_PREVIEW__ {"summary":"Q3 report","path":"${VALID_PATH}"}\nPreview rendered.`;
    expect(extractPreviewMarker(text)).toEqual({ summary: "Q3 report", path: VALID_PATH });
  });

  it("extracts from a tool_result content array (text block)", () => {
    const payload = [
      { type: "text", text: `__CWUI_PREVIEW__ {"summary":"x","path":"${VALID_PATH}"}` },
    ];
    expect(extractPreviewMarker(payload)).toEqual({ summary: "x", path: VALID_PATH });
  });

  it("returns undefined when marker absent", () => {
    expect(extractPreviewMarker("just some text")).toBeUndefined();
    expect(extractPreviewMarker(undefined)).toBeUndefined();
  });

  it("returns undefined when JSON malformed", () => {
    expect(extractPreviewMarker("__CWUI_PREVIEW__ {not json}")).toBeUndefined();
  });

  it("returns undefined when path doesn't match expected shape", () => {
    expect(extractPreviewMarker(`__CWUI_PREVIEW__ {"summary":"x","path":"/etc/passwd"}`)).toBeUndefined();
  });

  it("returns undefined when summary or path missing", () => {
    expect(extractPreviewMarker(`__CWUI_PREVIEW__ {"path":"${VALID_PATH}"}`)).toBeUndefined();
    expect(extractPreviewMarker(`__CWUI_PREVIEW__ {"summary":"x"}`)).toBeUndefined();
  });
});

describe("groupTimeline + preview marker", () => {
  function rec(o: object) { return JSON.stringify(o); }

  it("attaches preview annotation to the matching ToolPair", () => {
    const stdoutText = `__CWUI_PREVIEW__ {"summary":"Dashboard","path":"${VALID_PATH}"}\nPreview rendered in the UI.`;
    const lines = [
      rec({
        type: "assistant", uuid: "a1",
        message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "cwui-preview --summary Dashboard /tmp/x.html" } }] },
      }),
      rec({
        type: "user", uuid: "u1",
        message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: stdoutText }] },
      }),
    ];
    const t = groupTimeline(lines);
    expect(t.length).toBe(1);
    const node = t[0]! as Extract<TimelineNode, { kind: "event" }>;
    const pair = node.toolPairs?.[0];
    expect(pair?.preview).toEqual({ summary: "Dashboard", path: VALID_PATH });
  });

  it("leaves preview unset when the tool_result has no marker", () => {
    const lines = [
      rec({
        type: "assistant", uuid: "a1",
        message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] },
      }),
      rec({
        type: "user", uuid: "u1",
        message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "total 0" }] },
      }),
    ];
    const t = groupTimeline(lines);
    const node = t[0]! as Extract<TimelineNode, { kind: "event" }>;
    expect(node.toolPairs?.[0]?.preview).toBeUndefined();
  });
});
