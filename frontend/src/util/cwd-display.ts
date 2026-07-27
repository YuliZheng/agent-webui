export function displayCwd(raw: string | null | undefined, home: string | null): string {
  if (!raw) return "(no cwd)";
  // Strip a network-storage physical prefix so the visible path starts with
  // the logical group, e.g. /physical/gpfs/<cluster>/<fs>/data_files/<g>/<user>/foo
  // becomes /<g>/<user>/foo. No-op for paths that don't match.
  const stripped = raw.replace(/^\/physical\/gpfs\/[^/]+\/[^/]+\/data_files\//, "/");
  // Direct home match. Windows paths are case-insensitive and use backslashes,
  // while Unix paths are case-sensitive. Preserve the original suffix style
  // so C:\Users\alice\project becomes ~\project.
  const cleanHome = home?.replace(/[\\/]+$/, "") ?? "";
  if (cleanHome) {
    const windowsPath = /^[a-z]:[\\/]/i.test(stripped) || /^[a-z]:[\\/]/i.test(cleanHome);
    const candidate = windowsPath ? stripped.toLowerCase() : stripped;
    const expected = windowsPath ? cleanHome.toLowerCase() : cleanHome;
    const boundary = stripped.charAt(cleanHome.length);
    if (
      candidate === expected
      || (candidate.startsWith(expected) && (boundary === "/" || boundary === "\\"))
    ) {
      return "~" + stripped.slice(cleanHome.length);
    }
  }
  // After the prefix strip, the path is usually /<group>/<user>/... — if
  // the trailing user segment matches the home basename, treat that
  // /<group>/<user> prefix as the home dir too. The backend reports
  // os.homedir() which is the /home/<user> symlink form; the underlying
  // physical path resolves to /<group>/<user>/... after strip, and both
  // refer to the same place. Treat them as equivalent so the user sees
  // a single "~/..." form everywhere.
  const homeBase = cleanHome.split(/[\\/]/).filter(Boolean).pop();
  if (homeBase) {
    const re = new RegExp(`^/[^/]+/${homeBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`);
    if (re.test(stripped)) {
      return stripped.replace(re, "~$1");
    }
  }
  return stripped;
}
