import {
  CATALOG_VERSION,
  MODULE_CATALOG,
  type DeviceConfiguration,
  type ModuleId,
  type NeedTag,
  type ProfileFact,
  type QuestionId,
  type SessionState,
  type SessionView,
  type Turn,
  type TurnInput,
} from "@walker/contracts";
import { matchNeeds, type MatchResult } from "./matcher";
import { QUESTIONS, getQuestion, toQuestionView, topicTags, type OptionDefinition, type QuestionDefinition } from "./questions";
import { activeTags, recommend } from "./recommend";

/**
 * Pure session transitions. Nothing here touches storage, the clock or randomness directly: the
 * service passes `now`, and ids come from a per-session counter, so the same inputs always produce
 * the same session. The current question is derived from the answers rather than stored, so a
 * restored session resumes at the first unanswered question. The one exception is a question the
 * onboarding agent chose to ask next (`pending`).
 */

export interface Answer {
  option_ids: string[];
  text: string | null;
  skipped: boolean;
  /** Set when the agent found this topic answered by words typed for another question: that fact's id. */
  covered_by?: string;
}

/** A bank question in the onboarding agent's words. Its options are the bank's, so a choice always means what the bank says. */
export interface PendingQuestion {
  id: QuestionId;
  prompt: string;
  detail: string;
  /** Some of that bank question's options, in the order to show them. */
  option_ids: string[];
}

export interface EngineSession {
  id: string;
  /** demo: anonymous, owned by a secret token, deleted after an hour. account: owned by a signed-in user. */
  kind: "demo" | "account";
  revision: number;
  catalog_version: number;
  input_mode: "text";
  created_at: string;
  expires_at: string;
  turns: Turn[];
  answers: Partial<Record<QuestionId, Answer>>;
  facts: ProfileFact[];
  /** Set while the user is changing an earlier answer. */
  revisit: QuestionId | null;
  /** The agent's next question, until it is answered or skipped. */
  pending: PendingQuestion | null;
  configuration: DeviceConfiguration | null;
  next_id: number;
}

export class EngineError extends Error {
  override readonly name = "EngineError";
  constructor(
    readonly code: "question_mismatch" | "session_confirmed" | "invalid_request" | "invalid_selection" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

export interface Transition {
  session: EngineSession;
  /** What was just recorded, for a polite live-region announcement. */
  ack: string | null;
  assistant_text: string;
}

const OPENING =
  "Hi. I'll ask a few short questions about what you'd like help with, then suggest walker modules that fit. You can skip any question, and change anything before you save.";
const REVIEW_READY = "That's everything I need. Check what I understood, then choose your modules.";

export function createSession(id: string, now: Date, ttlMs: number, kind: EngineSession["kind"] = "demo"): EngineSession {
  const base: EngineSession = {
    id,
    kind,
    revision: 0,
    catalog_version: CATALOG_VERSION,
    input_mode: "text",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    turns: [],
    answers: {},
    facts: [],
    revisit: null,
    pending: null,
    configuration: null,
    next_id: 1,
  };
  const first = currentQuestion(base);
  const opening = say(base, now, "assistant", OPENING, null);
  return first ? say(opening, now, "assistant", first.prompt, first.id) : opening;
}

// ---- Derived state ----

function tagsExcept(session: EngineSession, q: QuestionId): Set<NeedTag> {
  return activeTags(session.facts.filter((f) => f.question_id !== q));
}

export function applicableQuestions(session: EngineSession): QuestionDefinition[] {
  return QUESTIONS.filter((q) => !q.appliesWhen || q.appliesWhen(tagsExcept(session, q.id)));
}

function pendingQuestion(p: PendingQuestion): QuestionDefinition {
  const q = getQuestion(p.id);
  return { ...q, prompt: p.prompt, detail: p.detail, options: p.option_ids.flatMap((id) => q.options.filter((o) => o.id === id)) };
}

export function currentQuestion(session: EngineSession): QuestionDefinition | null {
  if (session.configuration) return null;
  if (session.revisit) return getQuestion(session.revisit);
  if (session.pending) return pendingQuestion(session.pending);
  return applicableQuestions(session).find((q) => !session.answers[q.id]) ?? null;
}

export function stateOf(session: EngineSession, now: Date): SessionState {
  if (session.configuration) return "confirmed";
  if (now.getTime() > Date.parse(session.expires_at)) return "expired";
  return currentQuestion(session) ? "collecting" : "review";
}

/** The state as stored: like stateOf, but without the clock ("expired" is worked out on read). */
export function storedState(session: EngineSession): Exclude<SessionState, "expired"> {
  if (session.configuration) return "confirmed";
  return currentQuestion(session) ? "collecting" : "review";
}

export function toView(session: EngineSession, now: Date): SessionView {
  const applicable = applicableQuestions(session);
  const current = currentQuestion(session);
  return {
    session_id: session.id,
    kind: session.kind,
    state: stateOf(session, now),
    revision: session.revision,
    catalog_version: session.catalog_version,
    input_mode: session.input_mode,
    created_at: session.created_at,
    expires_at: session.expires_at,
    current_question: current ? toQuestionView(current) : null,
    current_answer: (() => {
      // An agent's follow-up asks for something new, so it starts empty.
      const a = current && !session.pending ? session.answers[current.id] : undefined;
      return a && !a.skipped ? { option_ids: a.option_ids, text: a.text } : null;
    })(),
    progress: { answered: applicable.filter((q) => session.answers[q.id]).length, total: applicable.length },
    turns: session.turns,
    facts: session.facts,
    recommendations: recommend(MODULE_CATALOG, session.facts),
    configuration: session.configuration,
  };
}

// ---- Transitions ----

function nextId(session: EngineSession, prefix: string): [EngineSession, string] {
  return [{ ...session, next_id: session.next_id + 1 }, `${prefix}_${session.next_id}`];
}

function say(session: EngineSession, now: Date, role: Turn["role"], text: string, question_id: QuestionId | null): EngineSession {
  const [s, id] = nextId(session, "turn");
  return { ...s, turns: [...s.turns, { id, role, text, question_id, created_at: now.toISOString() }] };
}

/** True while a fact still has a tag from that question's topic. */
export function backs(fact: ProfileFact, q: QuestionId): boolean {
  const tags = topicTags(q);
  return [...fact.tags, ...fact.declined_tags].some((t) => tags.has(t));
}

/**
 * Drops answers and facts for questions that no longer apply (for example after "picking things up"
 * is removed), and reopens a topic the agent counted as covered once the words behind it are gone.
 */
function prune(session: EngineSession): EngineSession {
  let s = session;
  for (let changed = true; changed; ) {
    changed = false;
    const uncovered = (Object.keys(s.answers) as QuestionId[]).filter((q) => {
      const by = s.answers[q]?.covered_by;
      const fact = by ? s.facts.find((f) => f.id === by) : undefined;
      return by !== undefined && !(fact && backs(fact, q));
    });
    if (uncovered.length > 0) {
      const answers = { ...s.answers };
      uncovered.forEach((q) => delete answers[q]);
      s = { ...s, answers };
      changed = true;
    }
    const applicable = new Set(applicableQuestions(s).map((q) => q.id));
    const stale = (Object.keys(s.answers) as QuestionId[]).filter((q) => !applicable.has(q));
    if (stale.length > 0) {
      const answers = { ...s.answers };
      stale.forEach((q) => delete answers[q]);
      s = { ...s, answers, facts: s.facts.filter((f) => applicable.has(f.question_id)) };
      changed = true;
    }
    if (s.revisit && !applicable.has(s.revisit)) s = { ...s, revisit: null };
    if (s.pending && !applicable.has(s.pending.id)) s = { ...s, pending: null };
  }
  return s;
}

function sentenceList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "A vibration in the handles" → "a vibration in the handles", but "I'm not sure yet" stays as it is. */
function lowerFirst(s: string): string {
  return /^(?:I\b|I'|[A-Z]{2})/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

/** Records the next prompt (or the review message) after an answer, skip or edit. */
export function advance(session: EngineSession, now: Date, ack: string): Transition {
  const next = currentQuestion(session);
  const followUp = next ? next.prompt : REVIEW_READY;
  const withAck = say(session, now, "assistant", ack, null);
  const s = say(withAck, now, "assistant", followUp, next?.id ?? null);
  return { session: s, ack, assistant_text: `${ack} ${followUp}` };
}

export type AnswerTurn = Extract<TurnInput, { type: "text" | "answer" }>;

/** A text or answer turn, checked against the current question. */
export interface PreparedAnswer {
  question: QuestionDefinition;
  options: OptionDefinition[];
  text: string | null;
}

function checkCurrent(input: EngineSession, questionId: QuestionId | undefined): QuestionDefinition {
  if (input.configuration) throw new EngineError("session_confirmed", "This setup has already been saved.");
  const current = currentQuestion(input);
  if (!current || (questionId ?? current.id) !== current.id) {
    throw new EngineError("question_mismatch", "That answer is for a different question. The page has been updated.");
  }
  return current;
}

export function prepareAnswer(input: EngineSession, turn: AnswerTurn): PreparedAnswer {
  const current = checkCurrent(input, turn.type === "answer" ? turn.question_id : undefined);
  const optionIds = turn.type === "answer" ? [...new Set(turn.option_ids)] : [];
  const text = (turn.type === "text" ? turn.text : turn.text ?? "").trim() || null;
  const options = optionIds.map((id) => {
    const option = current.options.find((o) => o.id === id);
    if (!option) throw new EngineError("invalid_request", `Unknown option ${id} for this question.`);
    return option;
  });
  if (current.selection === "single" && options.length > 1) {
    throw new EngineError("invalid_request", "Choose one option for this question.");
  }
  if (options.length === 0 && !text) throw new EngineError("invalid_request", "Choose an option or write an answer.");
  return { question: current, options, text };
}

/** True when the current question is an agent's follow-up to a question the user already answered. */
export function isFollowUp(input: EngineSession, q: QuestionId): boolean {
  const prior = input.answers[q];
  return Boolean(prior && !prior.skipped && input.revisit !== q);
}

/**
 * Records an answer: one fact per chosen option, in the bank's words and tags, and the user's own
 * words as one fact with the tags `reading` found in them. A new answer to a question replaces its
 * earlier facts; an answer to the agent's follow-up adds to them.
 */
export function recordAnswer(input: EngineSession, answer: PreparedAnswer, reading: MatchResult | null, now: Date): EngineSession {
  const { question, options, text } = answer;
  const prior = isFollowUp(input, question.id) ? input.answers[question.id] : undefined;
  let s: EngineSession = {
    ...input,
    revisit: null,
    pending: null,
    facts: prior ? input.facts : input.facts.filter((f) => f.question_id !== question.id),
  };
  for (const option of options) {
    // A follow-up can offer an option the user already chose; it is recorded once.
    if (!option.fact || prior?.option_ids.includes(option.id)) continue;
    const [withId, id] = nextId(s, "fact");
    s = {
      ...withId,
      facts: [
        ...withId.facts,
        { id, question_id: question.id, text: option.fact, source: "chosen", tags: option.tags, declined_tags: option.declined_tags ?? [] },
      ],
    };
  }
  if (text) {
    const [withId, id] = nextId(s, "fact");
    const fact = { id, question_id: question.id, text, source: "typed" as const, tags: reading?.tags ?? [], declined_tags: reading?.declined_tags ?? [] };
    s = { ...withId, facts: [...withId.facts, fact] };
  }
  const optionIds = [...new Set([...(prior?.option_ids ?? []), ...options.map((o) => o.id)])];
  const allText = [prior?.text, text].filter(Boolean).join(" ") || null;
  s = { ...s, answers: { ...s.answers, [question.id]: { option_ids: optionIds, text: allText, skipped: false } } };

  const labels = options.map((o) => o.label);
  s = say(s, now, "user", [...labels, ...(text ? [text] : [])].join(". "), question.id);
  return prune(s);
}

/** The deterministic engine's acknowledgement for an answer. */
export function answerAck({ options, text }: PreparedAnswer): string {
  const labels = options.map((o) => o.label);
  return labels.length > 0
    ? `Noted: ${sentenceList(labels.map(lowerFirst))}.${text ? " I've added your note too." : ""}`
    : "Thanks, I've added that to what I understood.";
}

export function applyInput(input: EngineSession, turn: TurnInput, now: Date): Transition {
  if (input.configuration) throw new EngineError("session_confirmed", "This setup has already been saved.");

  if (turn.type === "revisit") {
    const target = applicableQuestions(input).find((q) => q.id === turn.question_id);
    if (!target) throw new EngineError("question_mismatch", "That question doesn't apply right now.");
    const s = say({ ...input, revisit: target.id, pending: null }, now, "assistant", target.prompt, target.id);
    return { session: s, ack: null, assistant_text: target.prompt };
  }

  if (turn.type === "skip_rest") {
    // Leaving a revisit keeps that question's earlier answer; only unanswered questions are skipped.
    let s: EngineSession = { ...input, revisit: null, pending: null };
    for (let q = currentQuestion(s); q; q = currentQuestion(s)) {
      s = { ...s, answers: { ...s.answers, [q.id]: { option_ids: [], text: null, skipped: true } } };
    }
    s = say(s, now, "user", "Skip the rest of the questions", null);
    return advance(s, now, "No problem, I've skipped the rest.");
  }

  if (turn.type === "skip") {
    const current = checkCurrent(input, turn.question_id);
    // Skipping a follow-up keeps the answer it followed up on.
    let s: EngineSession = isFollowUp(input, current.id)
      ? { ...input, pending: null }
      : {
          ...input,
          revisit: null,
          pending: null,
          answers: { ...input.answers, [current.id]: { option_ids: [], text: null, skipped: true } },
          facts: input.facts.filter((f) => f.question_id !== current.id),
        };
    s = say(s, now, "user", "Skipped", current.id);
    return advance(prune(s), now, "No problem, skipped.");
  }

  const answer = prepareAnswer(input, turn);
  return advance(recordAnswer(input, answer, answer.text ? matchNeeds(answer.text) : null, now), now, answerAck(answer));
}

export function editFact(
  input: EngineSession,
  edit: { type: "update"; fact_id: string; text: string } | { type: "remove"; fact_id: string },
): EngineSession {
  if (input.configuration) throw new EngineError("session_confirmed", "This setup has already been saved.");
  const fact = input.facts.find((f) => f.id === edit.fact_id);
  if (!fact) throw new EngineError("not_found", "That item is no longer in the summary.");
  const facts =
    edit.type === "remove"
      ? input.facts.filter((f) => f.id !== edit.fact_id)
      : input.facts.map((f) => (f.id === edit.fact_id ? { ...f, text: edit.text, source: "edited" as const, ...matchNeeds(edit.text) } : f));
  return prune({ ...input, facts });
}

/** `version`: the owner's next configuration_version (1 for a demo, 1, 2, 3… per account). */
export function confirm(input: EngineSession, selected: readonly ModuleId[], now: Date, version = 1): EngineSession {
  if (input.configuration) throw new EngineError("session_confirmed", "This setup has already been saved.");
  const tags = activeTags(input.facts);
  const cues = (
    [
      ["vibration_feedback", "vibration"],
      ["spoken_feedback", "spoken"],
      ["sound_feedback", "sound"],
      ["screen_feedback", "screen"],
    ] as const
  )
    .filter(([t]) => tags.has(t))
    .map(([, c]) => c);
  const starts = (
    [
      ["button_left", "left_button"],
      ["button_right", "right_button"],
      ["speak_requests", "voice"],
      ["app_requests", "app"],
    ] as const
  )
    .filter(([t]) => tags.has(t))
    .map(([, c]) => c);
  const ordered = MODULE_CATALOG.modules.map((m) => m.id).filter((id) => selected.includes(id));
  return {
    ...input,
    revisit: null,
    configuration: {
      configuration_version: version,
      catalog_version: input.catalog_version,
      selected_module_ids: ordered,
      preferences: { cues, request_start: starts },
      confirmed_at: now.toISOString(),
      source: input.kind,
    },
  };
}

/** Produces a turn's transition. The deterministic engine is the default; the agent engine (agent.ts) falls back to it. */
export interface TurnEngine {
  readonly kind: "deterministic" | "agent";
  apply(session: EngineSession, turn: TurnInput, now: Date): Promise<Transition>;
}

export const deterministicEngine: TurnEngine = {
  kind: "deterministic",
  apply: async (session, turn, now) => applyInput(session, turn, now),
};
