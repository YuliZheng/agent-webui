import { describe, expect, it } from "vitest";
import { initialsFromHome } from "@/stores/identity";

describe("identity initials", () => {
  it("derives the fallback from Windows, POSIX, and multi-word home names", () => {
    expect(initialsFromHome("C:\\Users\\11947")).toBe("11");
    expect(initialsFromHome("/home/alice")).toBe("AL");
    expect(initialsFromHome("/Users/yu-zheng/")).toBe("YZ");
    expect(initialsFromHome("")).toBe("ME");
  });
});
