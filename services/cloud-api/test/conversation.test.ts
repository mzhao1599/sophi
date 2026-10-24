import { describe, expect, it } from "vitest";
import { QuestionSchema, type QuestionId, type SessionView, type TurnInput } from "@walker/contracts";
import { MemorySessionStore, OnboardingService, SKIP_REPLY, SKIP_REST_REPLY, openingQuestion } from "../src";
import { REVIEW_READY } from "../src/onboarding/engine";
import { QUESTIONS, toQuestionView } from "../src/onboarding/questions";

/**
 * The deterministic engine as a chat: each reply is the acknowledgement and the next question in one
 * bubble, a tapped option is the person's own message, and typed words that answer a later topic
 * skip it.
 */

function setup() {
  const now = () => new Date("2026-10-23T17:00:00Z");
  let n = 0;
  return new OnboardingService(new MemorySessionStore(now), {
    now,
    randomId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
}

let turnCounter = 0;
async function conversation(service: OnboardingService) {
  const { token, response } = await service.start({ input_mode: "text", consent: { demo_data_notice: true } });
  let view = response.session;
  const id = view.session_id;
  return {
    get view() {
      return view;
    },
    async send(input: TurnInput) {
      const client_turn_id = `50000000-0000-4000-8000-${String(++turnCounter).padStart(12, "0")}`;
      const r = await service.turn(id, { token }, { client_turn_id, last_seen_revision: view.revision, input });
      view = r.session;
      return r;
    },
    async edit(edit: { type: "update"; fact_id: string; text: string } | { type: "remove"; fact_id: string }) {
      view = (await service.editProfile(id, { token }, { last_seen_revision: view.revision, edit })).session;
      return view;
    },
  };
}

const firstWord = (s: string) => s.split(/[ ,:.]/)[0];
const BANNED = /—|–|…|\.\.\.|\bNoted\b/;
const unanswered = (view: SessionView) => view.progress.total - view.progress.answered;

describe("conversation copy", () => {
  it("keeps every prompt within the contract and every option short enough to send as a message", () => {
    for (const q of QUESTIONS) {
      QuestionSchema.parse(toQuestionView(q));
      for (const prompt of [q.prompt, q.revisit_prompt ?? q.prompt]) {
        expect(prompt.length, prompt).toBeLessThanOrEqual(48);
        expect(prompt, prompt).toMatch(/\?$/);
      }
      for (const o of q.options) {
        expect(o.label.length, o.label).toBeLessThanOrEqual(34);
        expect(o.ack, `${q.id}.${o.id}`).toMatch(/^[a-z]/);
      }
    }
  });

  it("has no em dashes, ellipses or \"Noted\" in anything the engine says", () => {
    const said = [
      REVIEW_READY,
      SKIP_REPLY,
      SKIP_REST_REPLY,
      ...QUESTIONS.flatMap((q) => [q.prompt, q.revisit_prompt ?? "", q.ack_opener, q.typed_ack, ...q.options.flatMap((o) => [o.label, o.ack])]),
    ];
    for (const s of said) expect(s, s).not.toMatch(BANNED);
  });

  it("opens each question's acknowledgement differently", () => {
    expect(new Set(QUESTIONS.map((q) => q.ack_opener)).size).toBe(QUESTIONS.length);
    expect(new Set(QUESTIONS.map((q) => q.typed_ack)).size).toBe(QUESTIONS.length);
    for (let i = 1; i < QUESTIONS.length; i++) {
      expect(firstWord(QUESTIONS[i]!.typed_ack)).not.toBe(firstWord(QUESTIONS[i - 1]!.typed_ack));
    }
  });

  it("says back chosen options in the person's terms, with a different opener each turn", async () => {
    const c = await conversation(setup());
    expect(c.view.current_question?.prompt).toBe("Hi! What would you like a hand with?");
    const answers: Partial<Record<QuestionId, string[]>> = {
      tasks: ["obstacles", "reach"],
      places: ["home", "outdoors"],
      feedback: ["vibration"],
      start_request: ["left", "voice"],
      reach_detail: ["high"],
      location: ["unsure"],
      anything_else: ["nothing"],
    };
    const replies: { ack: string | null; assistant_text: string }[] = [];
    const sent: string[] = [];
    while (c.view.current_question) {
      const q = c.view.current_question;
      const r = await c.send({ type: "answer", question_id: q.id, option_ids: answers[q.id]! });
      sent.push(c.view.turns.findLast((t) => t.role === "user")!.text);
      replies.push(r);
    }
    expect(replies.map((r) => r.ack)).toEqual([
      "Got it, knowing what's in your way and help picking things up.",
      "Good to know: at home and outside.",
      "Sounds good, a buzz in the handles.",
      "All right, a button on the left handle and saying it out loud.",
      "Okay, things on a high shelf.",
      "Understood, you'll decide later.",
      "Thanks, that's everything.",
    ]);
    // A tapped option is the person's own message.
    expect(sent[0]).toBe("Knowing what's in my way. Picking up or reaching for things");
    expect(replies[1]!.assistant_text).toBe("Good to know: at home and outside. How should the walker get your attention?");
    expect(replies.at(-1)!.assistant_text).toBe("Thanks, that's everything. Here's your walker.");
    for (let i = 1; i < replies.length; i++) expect(firstWord(replies[i]!.ack!)).not.toBe(firstWord(replies[i - 1]!.ack!));
    for (const t of c.view.turns) expect(t.text).not.toMatch(BANNED);
  });

  it("says typed words back in the person's terms, or thanks them when nothing was read", async () => {
    const c = await conversation(setup());
    const acks: string[] = [];
    acks.push((await c.send({ type: "text", text: "Bigger controls would be nice" })).ack!);
    acks.push((await c.send({ type: "text", text: "Mostly the garden" })).ack!);
    acks.push((await c.send({ type: "answer", question_id: "feedback", option_ids: ["sound"], text: "and not too loud" })).ack!);
    acks.push((await c.send({ type: "text", text: "Hmm, not sure" })).ack!);
    expect(acks).toEqual(["Got it, buttons that are easy to press.", "Good to know, thanks.", "Sounds good, a short sound.", "All right, thanks."]);
  });

  it("answers skips briefly and records the person's own words for them", async () => {
    const c = await conversation(setup());
    const skip = await c.send({ type: "skip", question_id: "tasks" });
    expect(skip.ack).toBe("No problem.");
    expect(skip.assistant_text).toBe("No problem. Where will you be using your walker?");
    expect(c.view.turns.findLast((t) => t.role === "user")?.text).toBe("Skip");
    const rest = await c.send({ type: "skip_rest" });
    expect(rest.assistant_text).toBe("Sure. Here's your walker.");
    expect(c.view.turns.findLast((t) => t.role === "user")?.text).toBe("Show me my walker");
    expect([SKIP_REPLY, SKIP_REST_REPLY]).toEqual(["Skip", "Show me my walker"]);
  });

  it("greets only the first time: a revisit asks the first question without the hello", async () => {
    const c = await conversation(setup());
    expect(openingQuestion().prompt).toBe("Hi! What would you like a hand with?");
    await c.send({ type: "answer", question_id: "tasks", option_ids: ["obstacles"] });
    const r = await c.send({ type: "revisit", question_id: "tasks" });
    expect(r.assistant_text).toBe("What would you like a hand with?");
    expect(c.view.current_question?.prompt).toBe("What would you like a hand with?");
  });
});

describe("typed words that answer later topics", () => {
  const words = "I keep bumping into door frames at home, and a buzz in the handles would help";

  it("skip places and feedback when the first answer already says where and how", async () => {
    const c = await conversation(setup());
    const r = await c.send({ type: "text", text: words });
    expect(c.view.facts).toEqual([
      { id: expect.any(String), question_id: "tasks", text: words, source: "typed", tags: ["notice_obstacles", "home", "vibration_feedback"], declined_tags: [] },
    ]);
    expect(r.assistant_text).toBe(
      "Got it, knowing what's in your way, at home and a buzz in the handles. How would you like to ask the walker for help?",
    );
    expect(c.view.progress).toEqual({ answered: 3, total: 6 });

    const asked: QuestionId[] = ["tasks"];
    while (c.view.current_question) {
      asked.push(c.view.current_question.id);
      await c.send({ type: "skip", question_id: c.view.current_question.id });
    }
    expect(asked).toEqual(["tasks", "start_request", "location", "anything_else"]);
    expect(c.view.state).toBe("review");
  });

  it("asks a covered topic again once the words behind it are edited or removed", async () => {
    const c = await conversation(setup());
    await c.send({ type: "text", text: words });
    await c.send({ type: "answer", question_id: "start_request", option_ids: ["left"] });
    const fact = c.view.facts[0]!;

    // Still about the home, no longer about a buzz: only feedback opens again.
    await c.edit({ type: "update", fact_id: fact.id, text: "I keep bumping into door frames at home" });
    expect(unanswered(c.view)).toBe(3);
    expect(c.view.current_question?.id).toBe("feedback");

    await c.edit({ type: "remove", fact_id: fact.id });
    expect(c.view.current_question?.id).toBe("places");
    const asked: QuestionId[] = [];
    while (c.view.current_question) {
      asked.push(c.view.current_question.id);
      await c.send({ type: "skip", question_id: c.view.current_question.id });
    }
    expect(asked).toEqual(["places", "feedback", "location", "anything_else"]);
  });

  it("lets the person change a covered topic, and keeps their own answer when the words go", async () => {
    const c = await conversation(setup());
    await c.send({ type: "text", text: words });
    const revisit = await c.send({ type: "revisit", question_id: "places" });
    expect(revisit.assistant_text).toBe("Where will you be using your walker?");
    expect(c.view.current_question?.id).toBe("places");
    await c.send({ type: "answer", question_id: "places", option_ids: ["outdoors"] });
    expect(c.view.current_question?.id).toBe("start_request");

    await c.edit({ type: "remove", fact_id: c.view.facts[0]!.id });
    // Places now has its own answer; feedback was covered only by the removed words.
    expect(c.view.facts.map((f) => f.question_id)).toEqual(["places"]);
    expect(c.view.current_question?.id).toBe("feedback");

    // A covered topic can also be skipped on a revisit, and stays skipped.
    const d = await conversation(setup());
    await d.send({ type: "text", text: words });
    await d.send({ type: "revisit", question_id: "feedback" });
    await d.send({ type: "skip", question_id: "feedback" });
    expect(d.view.current_question?.id).toBe("start_request");
    await d.edit({ type: "remove", fact_id: d.view.facts[0]!.id });
    expect(d.view.current_question?.id).toBe("places");
    await d.send({ type: "skip", question_id: "places" });
    expect(d.view.current_question?.id).toBe("start_request");
  });

  it("doesn't count a task as an answer to what to reach", async () => {
    const c = await conversation(setup());
    await c.send({ type: "text", text: "I'd like help picking up cups" });
    expect(c.view.facts[0]?.tags).toEqual(["pick_up"]);
    const asked: QuestionId[] = [];
    while (c.view.current_question) {
      asked.push(c.view.current_question.id);
      await c.send({ type: "skip", question_id: c.view.current_question.id });
    }
    expect(asked).toContain("reach_detail");
  });

  it("covers only later topics, so a topic that newly applies is still asked", async () => {
    const c = await conversation(setup());
    for (const q of ["tasks", "places", "feedback", "start_request", "location"] as const) await c.send({ type: "skip", question_id: q });
    expect(c.view.current_question?.id).toBe("anything_else");
    await c.send({ type: "text", text: "I'd like to reach things on high shelves" });
    expect(c.view.current_question?.id).toBe("reach_detail");
  });
});
