import type { Interaction } from "@/types";
import { isRecord } from "./storage";

export interface DisplayQuestion { key: string; question: string; options: Array<{ label: string; description?: string; value: unknown }>; multiSelect: boolean }

export function interactionQuestions(interaction: Interaction): DisplayQuestion[] {
  if (!Array.isArray(interaction.questions)) return [];
  return interaction.questions.flatMap((raw, index) => {
    if (!isRecord(raw) || typeof raw.question !== "string") return [];
    const options = Array.isArray(raw.options) ? raw.options.flatMap((option) => {
      if (!isRecord(option) || typeof option.label !== "string") return [];
      return [{ label: option.label, description: typeof option.description === "string" ? option.description : undefined, value: option.value ?? option.label }];
    }) : [];
    return [{ key: typeof raw.id === "string" ? raw.id : typeof raw.header === "string" ? raw.header : `question-${index + 1}`, question: raw.question, options, multiSelect: raw.multiSelect === true }];
  });
}

export function interactionToolSummary(interaction: Interaction): { name: string; input: string } | null {
  if (!interaction.toolName && interaction.input == null) return null;
  let input = "";
  try { input = typeof interaction.input === "string" ? interaction.input : JSON.stringify(interaction.input, null, 2); } catch { input = String(interaction.input); }
  return { name: interaction.toolName || "Tool", input };
}

const claimedAnswers = new Set<string>();
const MAX_ANSWER_CLAIMS = 1_000;
const answerKey = (interaction: Pick<Interaction, "sessionId" | "requestId">) => `${interaction.sessionId}\u0000${interaction.requestId}`;

/** Coordinates inline, tray, and toast controls so only the first click sends. */
export async function answerInteractionOnce(
  interaction: Interaction,
  answer: unknown,
  respond: (interaction: Interaction, answer: unknown) => Promise<void>,
): Promise<boolean> {
  const key = answerKey(interaction);
  if (claimedAnswers.has(key)) return false;
  if (claimedAnswers.size >= MAX_ANSWER_CLAIMS) claimedAnswers.delete(claimedAnswers.values().next().value ?? "");
  claimedAnswers.add(key);
  try {
    await respond(interaction, answer);
    return true;
  } catch (error) {
    throw error;
  } finally {
    claimedAnswers.delete(key);
  }
}

export function clearInteractionAnswerClaim(sessionId: string, requestId: string): void {
  claimedAnswers.delete(answerKey({ sessionId, requestId }));
}
