export function displayCwd(raw: string | null | undefined, home: string | null): string {
  if (!raw) return "(no cwd)";
  // Strip a network-storage physical prefix so the visible path starts with
  // the logical group, e.g. /physical/gpfs/<cluster>/<fs>/data_files/<g>/<user>/foo
  // becomes /<g>/<user>/foo. No-op for paths that don't match.
  const stripped = raw.replace(/^\/physical\/gpfs\/[^/]+\/[^/]+\/data_files\//, "/");
  // Direct home match (e.g. home = /home/alice, stripped happens to be that).
  if (home && (stripped === home || stripped.startsWith(home + "/"))) {
    return "~" + stripped.slice(home.length);
  }
  // After the prefix strip, the path is usually /<group>/<user>/... — if
  // the trailing user segment matches the home basename, treat that
  // /<group>/<user> prefix as the home dir too. The backend reports
  // os.homedir() which is the /home/<user> symlink form; the underlying
  // physical path resolves to /<group>/<user>/... after strip, and both
  // refer to the same place. Treat them as equivalent so the user sees
  // a single "~/..." form everywhere.
  const homeBase = home?.split("/").filter(Boolean).pop();
  if (homeBase) {
    const re = new RegExp(`^/[^/]+/${homeBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`);
    if (re.test(stripped)) {
      return stripped.replace(re, "~$1");
    }
  }
  return stripped;
}
