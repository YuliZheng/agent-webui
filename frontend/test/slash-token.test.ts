import { describe, it, expect } from "vitest";
import { findSlashToken } from "../src/util/slash-token.js";

describe("findSlashToken", () => {
  it("detects a token at the start of input", () => {
    expect(findSlashToken("/cla", 4)).toEqual({ start: 0, query: "cla" });
  });

  it("detects a bare slash with empty query", () => {
    expect(findSlashToken("/", 1)).toEqual({ start: 0, query: "" });
  });

  it("detects a token mid-message after whitespace", () => {
    const text = "do /foo";
    expect(findSlashToken(text, text.length)).toEqual({ start: 3, query: "foo" });
  });

  it("returns null for a path-like token with a second slash", () => {
    expect(findSlashToken("/home/sys", 9)).toBeNull();
  });

  it("returns null when the token does not start with slash", () => {
    expect(findSlashToken("abc/def", 7)).toBeNull();
  });

  it("is caret-relative (ignores text to the right of the caret)", () => {
    const text = "/foo and more";
    expect(findSlashToken(text, 4)).toEqual({ start: 0, query: "foo" });
  });

  it("returns null for non-name characters after the slash", () => {
    expect(findSlashToken("/foo!", 5)).toBeNull();
  });

  it("supports namespaced query characters (colon, dash)", () => {
    expect(findSlashToken("/super-powers:brain", 19)).toEqual({
      start: 0,
      query: "super-powers:brain",
    });
  });
});
