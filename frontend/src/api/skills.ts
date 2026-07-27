import type { SkillEntry } from "@claude-webui/shared/api";
import { request } from "./ws.js";

export async function getSessionSkills(
  sessionId: string,
  opts: { cwd?: string; agent?: "claude" | "codex" } = {},
): Promise<SkillEntry[]> {
  const r = await request<{ skills: SkillEntry[] }>("get-session-skills", { sessionId, ...opts });
  return r.skills;
}
