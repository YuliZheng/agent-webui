import { describe, it, expect } from "vitest";
import { insertAtCursor } from "../src/util/textarea.js";

describe("insertAtCursor", () => {
  it("inserts into empty textarea, no leading space", () => {
    const r = insertAtCursor("", 0, 0, "hello");
    expect(r.text).toBe("hello");
    expect(r.selectionStart).toBe(5);
    expect(r.selectionEnd).toBe(5);
  });

  it("inserts at cursor with leading space when prev char is non-space", () => {
    const r = insertAtCursor("ab|cd".replace("|", ""), 2, 2, "X");
    expect(r.text).toBe("ab Xcd");
    expect(r.selectionStart).toBe(4);
    expect(r.selectionEnd).toBe(4);
  });

  it("does not add leading space when prev char is whitespace", () => {
    const r = insertAtCursor("ab cd", 3, 3, "X");
    expect(r.text).toBe("ab Xcd");
    expect(r.selectionStart).toBe(4);
  });

  it("does not add leading space when insertion already starts with space", () => {
    const r = insertAtCursor("ab", 2, 2, " X");
    expect(r.text).toBe("ab X");
    expect(r.selectionStart).toBe(4);
  });

  it("replaces selection range", () => {
    const r = insertAtCursor("hello world", 6, 11, "everyone");
    expect(r.text).toBe("hello everyone");
    expect(r.selectionStart).toBe(14);
    expect(r.selectionEnd).toBe(14);
  });

  it("clamps out-of-range selection", () => {
    const r = insertAtCursor("ab", 99, 99, "X");
    expect(r.text).toBe("ab X");
    expect(r.selectionStart).toBe(4);
  });

  it("appends at end with leading space when text non-empty", () => {
    const r = insertAtCursor("hi", 2, 2, "there");
    expect(r.text).toBe("hi there");
    expect(r.selectionStart).toBe(8);
  });
});
