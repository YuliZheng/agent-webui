export interface CodexGoalFields { objective: string; status?: "active" | "complete" | "blocked"; tokenBudget?: number }

export function parseCodexGoalFields(input: string): CodexGoalFields | null {
  const value = input.trim(); if (!value) return null;
  if (!value.startsWith("{")) return { objective: value, status: "active" };
  let record: Record<string, unknown>;
  try { const parsed = JSON.parse(value) as unknown; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null; record = parsed as Record<string, unknown>; }
  catch { return null; }
  if (typeof record.objective !== "string" || !record.objective.trim()) return null;
  const status = record.status === "active" || record.status === "complete" || record.status === "blocked" ? record.status : undefined;
  const tokenBudget = Number.isSafeInteger(record.tokenBudget) && Number(record.tokenBudget) > 0 ? Number(record.tokenBudget) : undefined;
  return { objective: record.objective.trim(), ...(status ? { status } : {}), ...(tokenBudget ? { tokenBudget } : {}) };
}
