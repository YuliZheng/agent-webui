import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const sourceRoot = join(process.cwd(), "src");

function vueFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return vueFiles(path);
    return entry.name.endsWith(".vue") ? [path] : [];
  });
}

function classLiterals(source: string): string[] {
  const template = source.match(/<template>[\s\S]*<\/template>/)?.[0] ?? "";
  const literals: string[] = [];

  // Static class attributes are already class lists.
  for (const match of template.matchAll(/(?<!:)\bclass\s*=\s*"([\s\S]*?)"/g)) {
    literals.push(match[1] ?? "");
  }

  // Dynamic bindings contain JavaScript expressions. Only inspect their
  // quoted string literals, not ternary punctuation or identifiers.
  for (const binding of template.matchAll(/:class\s*=\s*"([\s\S]*?)"/g)) {
    for (const literal of (binding[1] ?? "").matchAll(/['`]([^'`]*)['`]/g)) {
      literals.push(literal[1] ?? "");
    }
  }

  return literals;
}

function isObviouslyIncompleteUtility(token: string): boolean {
  return token === "!"
    || /-(?:\/\d+)?$/.test(token)
    || /:[!]?$/i.test(token);
}

describe("Tailwind utility integrity", () => {
  it("does not leave truncated utility or variant tokens in Vue components", () => {
    const failures: string[] = [];

    for (const file of vueFiles(sourceRoot)) {
      const source = readFileSync(file, "utf8");
      for (const literal of classLiterals(source)) {
        for (const token of literal.split(/\s+/).filter(Boolean)) {
          if (isObviouslyIncompleteUtility(token)) {
            failures.push(`${relative(process.cwd(), file)}: ${token}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
