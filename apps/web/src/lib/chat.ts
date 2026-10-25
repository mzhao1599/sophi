import type { Question, QuestionId, Turn } from "@walker/contracts";

type QuestionOption = Question["options"][number];

/**
 * The conversation, derived from the session's turns so it survives a reload and always matches what
 * the server recorded. Kept free of React so it can be unit tested.
 */

export interface ChatMessage {
  /**
   * The message's position in the log. Positions only grow, so the bubble shown for a message still
   * being sent keeps its DOM node when the server's copy replaces it, and the log (an aria-live
   * region) doesn't announce it twice.
   */
  key: string;
  role: "assistant" | "user";
  text: string;
  /** The question an assistant message ends with, if any. */
  questionId: QuestionId | null;
  /** Who answered, while the agent runs: the model, or the fixed questions when its reply didn't come through. */
  answeredBy?: "model" | "fixed";
}

/**
 * What the person's bubble says for a skip, while it is being sent. The engine records the same words
 * (SKIP_REPLY and SKIP_REST_REPLY in services/cloud-api; a test checks they match).
 */
export const SKIP_REPLY = "Skip";
export const SKIP_REST_REPLY = "Show me my walker";

/**
 * The line under the text box, on screen before the first send: that answers are saved to the account
 * when signed in, and who else reads them when the agent runs. `agentNotice` is the agent's clause
 * ("Anthropic's Claude reads your answers to choose each question, and Anthropic may keep a copy"),
 * null with the fixed questions. Empty for a guest with the fixed questions: nothing leaves the setup,
 * so the page shows no line.
 */
export function noticeLine(agentNotice: string | null, signedIn: boolean): string {
  const parts = [signedIn ? "Your answers are saved to your account." : null, agentNotice ? `${agentNotice}.` : null];
  return parts.filter(Boolean).join(" ");
}

/**
 * One bubble per reply: the engine records an acknowledgement and the next question as separate
 * assistant turns, and they read as one message. `opening` is the first question, shown before a
 * session exists (the session starts on the first send); the engine's greeting before it is left out,
 * so the log looks the same before and after. `pending` is what the person just sent.
 */
export function chatMessages(turns: readonly Turn[] | null, opening: Question, pending: string | null): ChatMessage[] {
  const firstQuestion = turns ? turns.findIndex((t) => t.role === "assistant" && t.question_id !== null) : -1;
  const shown: Omit<ChatMessage, "key">[] = [];
  if (turns && firstQuestion >= 0) {
    for (const t of turns.slice(firstQuestion)) {
      const previous = shown.at(-1);
      if (t.role === "assistant" && previous?.role === "assistant") {
        previous.text = `${previous.text} ${t.text}`;
        previous.questionId = t.question_id;
        if (t.answered_by) previous.answeredBy = t.answered_by;
      } else {
        shown.push({
          role: t.role,
          text: t.text,
          questionId: t.role === "assistant" ? t.question_id : null,
          ...(t.answered_by ? { answeredBy: t.answered_by } : {}),
        });
      }
    }
  } else {
    shown.push({ role: "assistant", text: opening.prompt, questionId: opening.id });
  }
  if (pending) shown.push({ role: "user", text: pending, questionId: null });
  return shown.map((m, i) => ({ ...m, key: `m${i}` }));
}

/** At most three quick replies, from the current question's own options, in its order. */
export function quickReplies(question: Question | null): QuestionOption[] {
  return question ? question.options.slice(0, 3) : [];
}

/** The words of a message, for the word-by-word reveal. Spaces are put back between them. */
export function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * When word `index` of `count` starts to appear, in ms: 35 ms apart, closer together for long
 * messages, so the last word starts by 900 ms and the whole message is in place within about a second.
 */
export function revealDelay(index: number, count: number): number {
  const step = Math.min(35, 900 / Math.max(count - 1, 1));
  return Math.round(index * step);
}
