type Input = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");
const n = (v: unknown) => (typeof v === "number" ? v : NaN);
const trunc = (str: string, len: number) => (str.length > len ? str.slice(0, len) + "…" : str);

export function toolSummary(name: string, input: Input): string {
  const mcp = name.match(/^mcp__([^_]+)__(.+)$/);
  if (mcp) return `MCP · ${mcp[1]} · ${mcp[2]}`;

  switch (name) {
    case "Bash": {
      const desc = s(input.description);
      if (desc) return `Bash · ${desc}`;
      const cmd = s(input.command);
      return cmd ? `Bash · ${trunc(cmd, 60)}` : "Bash";
    }
    case "Read": {
      const f = s(input.file_path);
      const off = n(input.offset);
      const lim = n(input.limit);
      if (Number.isFinite(off) && Number.isFinite(lim)) {
        return `Read · ${f} · L${off}–L${off + lim}`;
      }
      return f ? `Read · ${f}` : "Read";
    }
    case "Edit": {
      const f = s(input.file_path);
      return f ? `Edit · ${f}` : "Edit";
    }
    case "Write": {
      const f = s(input.file_path);
      const content = s(input.content);
      const lines = content ? content.split("\n").length : 0;
      return f ? `Write · ${f}${lines ? ` · ${lines} lines` : ""}` : "Write";
    }
    case "Grep": {
      const p = s(input.pattern);
      const path = s(input.path);
      return p ? (path ? `Grep · "${p}" in ${path}` : `Grep · "${p}"`) : "Grep";
    }
    case "Glob": {
      const p = s(input.pattern);
      const path = s(input.path);
      return p ? (path ? `Glob · ${p} in ${path}` : `Glob · ${p}`) : "Glob";
    }
    case "WebFetch": return s(input.url) ? `WebFetch · ${s(input.url)}` : "WebFetch";
    case "WebSearch": return s(input.query) ? `WebSearch · "${s(input.query)}"` : "WebSearch";
    case "TaskCreate": return s(input.subject) ? `TaskCreate · ${s(input.subject)}` : "TaskCreate";
    case "TaskUpdate": {
      const id = s(input.taskId);
      const status = s(input.status);
      if (id && status) return `TaskUpdate · #${id} → ${status}`;
      return id ? `TaskUpdate · #${id}` : "TaskUpdate";
    }
    case "TaskGet": return s(input.taskId) ? `TaskGet · #${s(input.taskId)}` : "TaskGet";
    case "TaskList": return "TaskList";
    case "TaskOutput": return s(input.task_id) ? `TaskOutput · #${s(input.task_id)}` : "TaskOutput";
    case "TaskStop": return s(input.task_id) ? `TaskStop · #${s(input.task_id)}` : "TaskStop";
    case "Agent": {
      const t = s(input.subagent_type);
      const d = s(input.description);
      if (t && d) return `Agent · ${t} · ${d}`;
      return t ? `Agent · ${t}` : "Agent";
    }
    case "AskUserQuestion": {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      const first = qs[0] as { question?: string; header?: string } | undefined;
      const q = s(first?.header) || s(first?.question);
      return q ? `Ask · ${trunc(q, 60)}` : "Ask";
    }
    case "Skill": return s(input.skill) ? `Skill · ${s(input.skill)}` : "Skill";
    case "EnterPlanMode": return "EnterPlanMode";
    default: return name;
  }
}
