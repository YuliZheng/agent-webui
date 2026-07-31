export const CODEX_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

/**
 * Prefer the selected model's live Codex catalog over the compatibility list.
 * Older app-server/model-cache versions may omit effort metadata entirely.
 */
export function resolveCodexEffortChoices(
  supported: readonly { value: string }[] | null | undefined,
): readonly string[] {
  if (!supported?.length) return CODEX_REASONING_EFFORTS;
  const values = [...new Set(
    supported
      .map(option => option.value.trim())
      .filter(value => /^[0-9A-Za-z_-]+$/.test(value)),
  )];
  return values.length ? values : CODEX_REASONING_EFFORTS;
}
