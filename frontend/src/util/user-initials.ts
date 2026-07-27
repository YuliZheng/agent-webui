// Initials for the user's avatar fallback, derived from the home directory
// basename reported by the backend (`/home/<user>` → "US" from "user"). Kept
// neutral: no hardcoded identity in the bundle.
export function userInitials(home: string | null | undefined): string {
  const base = (home ?? "").split("/").filter(Boolean).pop() ?? "";
  if (!base) return "ME";
  return base.slice(0, 2).toUpperCase();
}
