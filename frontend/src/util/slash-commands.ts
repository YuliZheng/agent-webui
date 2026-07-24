export const LOCAL_SLASH_COMMANDS = new Set(["settings", "theme", "clear", "context", "status", "compact", "export", "model", "permissions", "approval", "mcp", "plugin", "hooks", "agents", "memory", "version", "doctor", "goal"]);

export function parseLocalSlashCommand(text: string): { command: string; args: string } | null {
  const match = text.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match || !LOCAL_SLASH_COMMANDS.has(match[1]!.toLowerCase())) return null;
  return { command: match[1]!.toLowerCase(), args: match[2] ?? "" };
}
