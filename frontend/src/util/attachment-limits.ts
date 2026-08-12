import {
  MAX_CLAUDE_PROMPT_ATTACHMENTS,
  MAX_CODEX_PROMPT_ATTACHMENTS,
  MAX_PROMPT_ATTACHMENT_BYTES,
  type AgentKind,
} from "@agent-webui/shared";

interface SizedAttachment {
  bytes: number;
}

export function promptAttachmentError(
  attachments: readonly SizedAttachment[],
  agent: AgentKind,
): string | null {
  const maxCount = agent === "codex"
    ? MAX_CODEX_PROMPT_ATTACHMENTS
    : MAX_CLAUDE_PROMPT_ATTACHMENTS;
  if (attachments.length > maxCount) {
    return `Too many attachments: ${agent === "codex" ? "Codex" : "Claude"} accepts up to ${maxCount} per message.`;
  }
  const totalBytes = attachments.reduce((total, attachment) => total + attachment.bytes, 0);
  if (totalBytes > MAX_PROMPT_ATTACHMENT_BYTES) {
    return "Attachments exceed the 40 MiB total limit. Remove some files or send them in smaller batches.";
  }
  return null;
}
