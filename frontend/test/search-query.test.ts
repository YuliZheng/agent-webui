import { describe, expect, it } from "vitest";
import {
  contentSearchMinChars,
  shouldRunContentSearch,
} from "../src/util/search-query.js";

describe("content search query threshold", () => {
  it("allows two-character digit-bearing technical terms", () => {
    for (const query of ["5g", "2G", "4k", "3d"]) {
      expect(contentSearchMinChars(query)).toBe(2);
      expect(shouldRunContentSearch(query)).toBe(true);
    }
  });

  it("keeps two-letter ASCII noise local-only", () => {
    expect(shouldRunContentSearch("is")).toBe(false);
    expect(shouldRunContentSearch("to")).toBe(false);
    expect(shouldRunContentSearch("api")).toBe(true);
  });

  it("allows two-character non-ASCII terms and rejects one character", () => {
    expect(shouldRunContentSearch("搜索")).toBe(true);
    expect(shouldRunContentSearch("5")).toBe(false);
    expect(shouldRunContentSearch("搜")).toBe(false);
  });
});
