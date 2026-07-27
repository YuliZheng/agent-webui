import { describe, expect, it } from "vitest";
import { displayCwd } from "../src/util/cwd-display.js";

describe("displayCwd", () => {
  it("shortens a Windows home path while preserving backslashes", () => {
    expect(displayCwd("C:\\Users\\11947\\agent-webui", "C:\\Users\\11947"))
      .toBe("~\\agent-webui");
    expect(displayCwd("c:\\users\\11947\\Downloads", "C:\\Users\\11947\\"))
      .toBe("~\\Downloads");
    expect(displayCwd("C:\\Users\\11947", "C:\\Users\\11947")).toBe("~");
  });

  it("does not shorten a sibling Windows username prefix", () => {
    expect(displayCwd("C:\\Users\\119470\\project", "C:\\Users\\11947"))
      .toBe("C:\\Users\\119470\\project");
  });

  it("keeps Unix and physical-home shortening behavior", () => {
    expect(displayCwd("/home/alice/project", "/home/alice")).toBe("~/project");
    expect(
      displayCwd(
        "/physical/gpfs/cluster/fs/data_files/group/alice/project",
        "/home/alice",
      ),
    ).toBe("~/project");
  });
});
