import type { Question, QuestionId, Turn } from "@walker/contracts";

/**
 * The chat log, derived from the session's turns so it survives a reload and always matches what the
 * server recorded. Kept free of React so it can be unit tested.
 */

export interface ChatMessage {
  /**
   * The message's position in the log. Positions only grow, so the bubble shown for a message still
   * being sent keeps its DOM node when the server's copy replaces it, and the log (an aria-live
   * region) doesn't announce it twice.
   */
  key: string;
  role: "assistant" | "user";
  /** question: the assistant asks something; note: a short acknowledgement; answer: the person's reply. */
  kind: "question" | "note" | "answer";
  text: string;
  questionId: QuestionId | null;
}

/**
 * `opening` is the first question, shown before a session exists (the session starts on the first send).
 * The engine's greeting before that question is left out, so the log looks the same before and after.
 * `pending` is what the person just sent, shown until the server answers.
 */
export function chatMessages(turns: readonly Turn[] | null, opening: Question, pending: string | null): ChatMessage[] {
  const firstQuestion = turns ? turns.findIndex((t) => t.role === "assistant" && t.question_id !== null) : -1;
  const shown: Omit<ChatMessage, "key">[] =
    turns && firstQuestion >= 0
      ? turns.slice(firstQuestion).map((t) => ({
          role: t.role,
          kind: t.role === "user" ? "answer" : t.question_id ? "question" : "note",
          text: t.text,
          questionId: t.question_id,
        }))
      : [{ role: "assistant", kind: "question", text: opening.prompt, questionId: opening.id }];
  if (pending) shown.push({ role: "user", kind: "answer", text: pending, questionId: null });
  return shown.map((m, i) => ({ ...m, key: `m${i}` }));
}

/** The person's reply as the engine records it: chosen labels in the order sent, then their own words, joined by ". ". */
export function replyText(question: Question, optionIds: readonly string[], text: string): string {
  const labels = optionIds.flatMap((id) => question.options.filter((o) => o.id === id).map((o) => o.label));
  return [...labels, ...(text.trim() ? [text.trim()] : [])].join(". ");
}

/** Chosen options in the order the question lists them, so the reply reads in that order too. */
export function inQuestionOrder(question: Question, optionIds: readonly string[]): string[] {
  return question.options.map((o) => o.id).filter((id) => optionIds.includes(id));
}
