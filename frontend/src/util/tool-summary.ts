const SHELL_TOOL_NAME = /(?:^|[.:/_-])(?:shell[_-]?command|exec(?:ute)?[_-]?command|local[_-]?shell[_-]?call)$/i;
const SUMMARY_MAX = 120;

export function isBashToolName(name: string | undefined): boolean {
  const value = name?.trim();
  return !!value && (value.toLowerCase() === "bash" || SHELL_TOOL_NAME.test(value));
}

export function toolDisplayName(name: string | undefined): string {
  return isBashToolName(name) ? "Bash" : name?.trim() || "Tool";
}

export function toolSummary(name: string | undefined, input: unknown): string {
  const tool = toolDisplayName(name);
  const record = inputRecord(input);
  const detail = record
    ? [
        record.command,
        record.cmd,
        record.script,
        record.file_path,
        record.path,
        record.filename,
        record.pattern,
        record.query,
        record.url,
        record.prompt,
        record.description
      ].map(detailText).find((value): value is string => !!value)
    : tool === "Bash" ? detailText(input) : undefined;
  if (!detail) return tool;
  const compact = detail.replace(/\s+/g, " ").trim();
  const concise = compact.length > SUMMARY_MAX ? `${compact.slice(0, SUMMARY_MAX - 3)}…` : compact;
  return `${tool}${tool === "Bash" ? ": " : " "}${concise}`;
}

function inputRecord(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input !== "string") return undefined;
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function detailText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
    return value.join(" ");
  }
  return undefined;
}
