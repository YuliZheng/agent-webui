#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceDir = resolve(scriptDir, "..");
const frontendDir = join(workspaceDir, "frontend");
const defaultLiveDir = join(frontendDir, "dist");
const stagingRoot = join(frontendDir, ".build-staging");

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function assertFile(path, message) {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(message);
  }
  if (!info.isFile()) throw new Error(message);
}

async function renameReplacing(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const retryable = ["EACCES", "EBUSY", "EPERM"].includes(error?.code);
      if (!retryable || attempt >= 20) throw error;
      await delay(Math.min(10 * (attempt + 1), 100));
    }
  }
}

async function copyFileAtomically(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const pending = join(
    dirname(destination),
    `.${basename(destination)}-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await copyFile(source, pending);
    await renameReplacing(pending, destination);
  } finally {
    await rm(pending, { force: true });
  }
}

async function copyTreeAtomically(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTreeAtomically(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await copyFileAtomically(sourcePath, destinationPath);
    } else {
      throw new Error(`Unexpected staged frontend entry: ${sourcePath}`);
    }
  }
}

export async function validateFrontendBuild(stagedDir) {
  const staged = resolve(stagedDir);
  const indexPath = join(staged, "index.html");
  await assertFile(indexPath, `Staged frontend is missing ${indexPath}`);

  const html = await readFile(indexPath, "utf8");
  if (!/id=["']app["']/.test(html)) {
    throw new Error("Staged frontend index.html is missing the #app mount point");
  }

  const localReferences = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) =>
      value !== ""
      && value !== "/"
      && !value.endsWith("/")
      && !value.startsWith("#")
      && !value.startsWith("//")
      && !/^[a-z][a-z\d+.-]*:/i.test(value),
    );

  if (!localReferences.some((value) => /\.js(?:[?#]|$)/i.test(value))) {
    throw new Error("Staged frontend index.html does not reference a JavaScript entry");
  }

  for (const reference of localReferences) {
    const withoutSuffix = reference.split(/[?#]/, 1)[0] ?? "";
    const target = resolve(staged, withoutSuffix.replace(/^[/\\]+/, ""));
    if (!isInside(staged, target)) {
      throw new Error(`Staged frontend reference escapes its output directory: ${reference}`);
    }
    await assertFile(target, `Staged frontend reference is missing: ${reference}`);
  }

  return { html, localReferences };
}

export async function publishFrontendBuild({ stagedDir, liveDir = defaultLiveDir }) {
  const staged = resolve(stagedDir);
  const live = resolve(liveDir);
  if (staged === live || isInside(staged, live) || isInside(live, staged)) {
    throw new Error("Staging and live frontend directories must be separate");
  }

  const validated = await validateFrontendBuild(staged);
  await mkdir(live, { recursive: true });

  // Copy every resource before changing index.html. Vite content-hashes the
  // executable assets, so concurrent publishers can safely leave both sets in
  // place. Old assets are intentionally retained for tabs that loaded the
  // previous index and may request a lazy chunk later.
  for (const entry of await readdir(staged, { withFileTypes: true })) {
    if (entry.name === "index.html") continue;
    const source = join(staged, entry.name);
    const destination = join(live, entry.name);
    if (entry.isDirectory()) {
      await copyTreeAtomically(source, destination);
    } else if (entry.isFile()) {
      await copyFileAtomically(source, destination);
    } else {
      throw new Error(`Unexpected staged frontend entry: ${source}`);
    }
  }

  // Commit the new HTML last. The temporary file is in the live directory, so
  // rename is a same-volume replacement: readers see the complete old file or
  // the complete new file, never a partially copied index.
  const liveIndex = join(live, "index.html");
  await copyFileAtomically(join(staged, "index.html"), liveIndex);

  return {
    liveDir: live,
    referenceCount: validated.localReferences.length,
  };
}

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(
        signal
          ? `Vite build terminated by ${signal}`
          : `Vite build exited with code ${code ?? "unknown"}`,
      ));
    });
  });
}

export async function buildAndPublishFrontend() {
  const stagedDir = join(
    stagingRoot,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID()}`,
  );
  await mkdir(stagedDir, { recursive: true });

  const requireFromFrontend = createRequire(join(frontendDir, "package.json"));
  const vitePackage = requireFromFrontend.resolve("vite/package.json");
  const viteBin = join(dirname(vitePackage), "bin", "vite.js");

  try {
    await run(
      process.execPath,
      [viteBin, "build", "--outDir", stagedDir, "--emptyOutDir"],
      { cwd: frontendDir },
    );
    const result = await publishFrontendBuild({ stagedDir });
    process.stdout.write(
      `Safely published frontend to ${result.liveDir} `
      + `(${result.referenceCount} validated index references).\n`,
    );
  } finally {
    if (!isInside(stagingRoot, stagedDir)) {
      throw new Error(`Refusing to clean unexpected staging path: ${stagedDir}`);
    }
    await rm(stagedDir, { recursive: true, force: true });
    try {
      await rmdir(stagingRoot);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  buildAndPublishFrontend().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
