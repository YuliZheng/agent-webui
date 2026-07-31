import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPathOpenCommand, resolveLocalPath } from "../src/services/files.js";

describe("local path system opening", () => {
  it("selects a Windows file in Explorer", () => {
    const launch = localPathOpenCommand("C:\\Users\\Alice\\Private Files\\README.md", "file", "win32");
    expect(launch.command).toBe("explorer.exe");
    expect(launch.args).toEqual(["/select,C:\\Users\\Alice\\Private Files\\README.md"]);
    expect(launch.options).toMatchObject({ detached: true, stdio: "ignore", windowsHide: false });
  });

  it("opens a Windows directory directly", () => {
    const launch = localPathOpenCommand("C:\\Users\\Alice\\Private Files", "directory", "win32");
    expect(launch.command).toBe("explorer.exe");
    expect(launch.args).toEqual(["C:\\Users\\Alice\\Private Files"]);
  });

  it("reveals files through native file managers on macOS and Linux", () => {
    expect(localPathOpenCommand("/Users/alice/report.md", "file", "darwin")).toMatchObject({
      command: "open",
      args: ["-R", "/Users/alice/report.md"],
    });
    expect(localPathOpenCommand("/home/alice/report.md", "file", "linux")).toMatchObject({
      command: "xdg-open",
      args: ["/home/alice"],
    });
  });

  it("allows only existing files and directories inside a permitted root", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agent-webui-local-path-"));
    const allowed = join(sandbox, "allowed");
    const directory = join(allowed, "Private Files");
    const file = join(directory, "README.md");
    const outside = join(sandbox, "outside.md");
    await mkdir(directory, { recursive: true });
    await Promise.all([writeFile(file, "index"), writeFile(outside, "outside")]);

    await expect(resolveLocalPath(directory, [allowed])).resolves.toMatchObject({
      path: directory,
      kind: "directory",
    });
    await expect(resolveLocalPath(file, [allowed])).resolves.toMatchObject({
      path: file,
      kind: "file",
    });
    await expect(resolveLocalPath(outside, [allowed])).rejects.toMatchObject({
      code: 403,
    });
  });
});
