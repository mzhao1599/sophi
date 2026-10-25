import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  OnboardingService,
  SKIP_REPLY as ENGINE_SKIP,
  SKIP_REST_REPLY as ENGINE_SKIP_REST,
  agentNoticeClause,
  openingQuestion,
} from "@walker/cloud-api";
import type { TurnInput } from "@walker/contracts";
import { SKIP_REPLY, SKIP_REST_REPLY, chatMessages, noticeLine, quickReplies, revealDelay, words } from "@/lib/chat";

// Sessions come from the real engine, so turns have their real shapes and wording.
async function conversation() {
  const service = new OnboardingService(new MemorySessionStore());
  const { token, response } = await service.start({ input_mode: "text", consent: { demo_data_notice: true } });
  let view = response.session;
  return {
    get view() {
      return view;
    },
    async send(input: TurnInput) {
      view = (await service.turn(view.session_id, { token: token! }, { client_turn_id: crypto.randomUUID(), last_seen_revision: view.revision, input }))
        .session;
      return view;
    },
  };
}

const opening = openingQuestion();
const shape = ({ key, role, text }: { key: string; role: string; text: string }) => ({ key, role, text });

describe("chatMessages", () => {
  it("carries who answered a reply into its message, and nothing with the deterministic engine", async () => {
    const c = await conversation();
    await c.send({ type: "answer", question_id: "tasks", option_ids: ["obstacles"] });
    expect(chatMessages(c.view.turns, opening, null).some((m) => "answeredBy" in m)).toBe(false);
    // As the agent engine marks them: the ack and the question it worded read as one message by the model.
    const marked = c.view.turns.map((t, i) => (t.role === "assistant" && i > 1 ? { ...t, answered_by: "model" as const } : t));
    expect(chatMessages(marked, opening, null).at(-1)).toMatchObject({ role: "assistant", answeredBy: "model" });
  });

  it("shows the opening question before a session exists, then what was just sent", () => {
    expect(chatMessages(null, opening, null)).toEqual([{ key: "m0", role: "assistant", text: opening.prompt, questionId: "tasks" }]);
    expect(chatMessages(null, opening, "Just the walker for now").at(-1)).toEqual({
      key: "m1",
      role: "user",
      text: "Just the walker for now",
      questionId: null,
    });
  });

  it("makes one bubble of each reply: the acknowledgement and the next question together", async () => {
    const c = await conversation();
    const option = opening.options[0]!;
    const before = chatMessages(null, opening, option.label);
    await c.send({ type: "answer", question_id: "tasks", option_ids: [option.id] });
    const messages = chatMessages(c.view.turns, opening, null);

    // The engine's greeting before the first question is left out; the first question and the reply
    // keep their place and words, so the log doesn't announce them again.
    expect(messages.slice(0, 2).map(shape)).toEqual(before.map(shape));
    expect(messages.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    const reply = messages[2]!;
    expect(reply.text).toBe(`${c.view.turns.at(-2)!.text} ${c.view.turns.at(-1)!.text}`);
    expect(reply.text.endsWith(c.view.current_question!.prompt)).toBe(true);
    expect(reply.questionId).toBe(c.view.current_question!.id);
  });

  it("shows a skip in the same words the engine records", async () => {
    expect([SKIP_REPLY, SKIP_REST_REPLY]).toEqual([ENGINE_SKIP, ENGINE_SKIP_REST]);
    const c = await conversation();
    await c.send({ type: "skip", question_id: "tasks" });
    await c.send({ type: "skip_rest" });
    const users = chatMessages(c.view.turns, opening, null).filter((m) => m.role === "user");
    expect(users.map((m) => m.text)).toEqual([SKIP_REPLY, SKIP_REST_REPLY]);
  });

  it("ends on one closing bubble once the walker is ready", async () => {
    const c = await conversation();
    await c.send({ type: "skip_rest" });
    expect(c.view.state).toBe("review");
    const last = chatMessages(c.view.turns, opening, null).at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.questionId).toBeNull();
    expect(last.text).toMatch(/your walker\.$/);
  });
});

describe("quick replies", () => {
  it("offers at most three of the question's own options, in its order", () => {
    expect(quickReplies(opening)).toEqual(opening.options.slice(0, 3));
    expect(quickReplies(null)).toEqual([]);
    expect(quickReplies({ ...opening, options: opening.options.slice(0, 2) })).toHaveLength(2);
  });
});

describe("the notice under the text box", () => {
  const claude = agentNoticeClause("anthropic");

  it("asks to leave out names and medical details for a guest, with and without the model's clause", () => {
    expect(noticeLine(claude, false)).toBe(
      "Your answers are kept temporarily for this setup. Anthropic's Claude reads them to choose each question, and Anthropic may keep a copy. Please leave out names and medical details.",
    );
    expect(noticeLine(null, false)).toBe("Your answers are kept temporarily for this setup. Please leave out names and medical details.");
  });

  it("asks the same when signed in, with and without the model's clause", () => {
    expect(noticeLine(claude, true)).toBe(
      "Your answers are saved to your account. Anthropic's Claude reads them to choose each question, and Anthropic may keep a copy. Please leave out names and medical details.",
    );
    expect(noticeLine(null, true)).toBe("Your answers are saved to your account. Please leave out names and medical details.");
  });
});

describe("word-by-word reveal", () => {
  it("splits on any whitespace", () => {
    expect(words("  Got it,\\n knowing   what's in your way. ".replace("\\n", "\n"))).toEqual(["Got", "it,", "knowing", "what's", "in", "your", "way."]);
  });

  it("starts words 35 ms apart, and every word by 900 ms however long the message", () => {
    expect([0, 1, 2].map((i) => revealDelay(i, 5))).toEqual([0, 35, 70]);
    for (const count of [1, 2, 10, 26, 27, 60, 200]) {
      const delays = Array.from({ length: count }, (_, i) => revealDelay(i, count));
      expect(delays[0]).toBe(0);
      expect(Math.max(...delays)).toBeLessThanOrEqual(900);
      for (let i = 1; i < count; i++) expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
  });
});
