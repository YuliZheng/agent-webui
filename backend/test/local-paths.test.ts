import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectLocalPath,
  listLocalDirectory,
  localPathOpenCommand,
  resolveLocalPath,
} from "../src/services/files.js";

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

  it("inspects and lists a directory without allowing navigation above its root", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-local-list-"));
    const folder = join(root, "Folder A");
    await mkdir(folder);
    await Promise.all([
      writeFile(join(root, "z.txt"), "z"),
      writeFile(join(root, "a.txt"), "a"),
      writeFile(join(folder, "inside.txt"), "inside"),
    ]);

    await expect(inspectLocalPath(join(root, "a.txt"), [root])).resolves.toMatchObject({
      name: "a.txt",
      kind: "file",
      size: 1,
    });
    const listing = await listLocalDirectory(root, [root]);
    expect(listing).toMatchObject({ name: expect.any(String), kind: "directory", parent: null, truncated: false });
    expect(listing.entries.map(entry => [entry.name, entry.kind])).toEqual([
      ["Folder A", "directory"],
      ["a.txt", "file"],
      ["z.txt", "file"],
    ]);

    const nested = await listLocalDirectory(folder, [root]);
    expect(nested.parent).toBe(root);
  });

  it("bounds large directory responses to 500 entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-webui-local-list-limit-"));
    await Promise.all(Array.from({ length: 501 }, (_, index) =>
      writeFile(join(root, `item-${String(index).padStart(3, "0")}.txt`), "x")));

    const listing = await listLocalDirectory(root, [root]);
    expect(listing.entries).toHaveLength(500);
    expect(listing.truncated).toBe(true);
  });
});
