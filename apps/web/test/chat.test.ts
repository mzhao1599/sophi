import { describe, expect, it } from "vitest";
import { MemorySessionStore, OnboardingService, openingQuestion } from "@walker/cloud-api";
import { chatMessages, inQuestionOrder, replyText } from "@/lib/chat";

async function started() {
  const service = new OnboardingService(new MemorySessionStore());
  const { token, response } = await service.start({ input_mode: "text", consent: { demo_data_notice: true } });
  return { service, token: token!, view: response.session };
}

const opening = openingQuestion();

describe("chatMessages", () => {
  it("shows the opening question before a session exists, then what was just sent", () => {
    expect(chatMessages(null, opening, null)).toEqual([
      { key: "m0", role: "assistant", kind: "question", text: "What would you like help with?", questionId: "tasks" },
    ]);
    expect(chatMessages(null, opening, "Just the walker for now").at(-1)).toEqual({
      key: "m1",
      role: "user",
      kind: "answer",
      text: "Just the walker for now",
      questionId: null,
    });
  });

  it("keeps each message at the same place once the server has recorded it, so nothing is announced twice", async () => {
    const { service, token, view } = await started();
    const ids = inQuestionOrder(opening, ["reach", "obstacles"]);
    const words = "  I keep bumping into door frames ";
    const before = chatMessages(null, opening, replyText(opening, ids, words));

    const after = (
      await service.turn(view.session_id, { token }, {
        client_turn_id: crypto.randomUUID(),
        last_seen_revision: view.revision,
        input: { type: "answer", question_id: "tasks", option_ids: ids, text: words.trim() },
      })
    ).session;
    const messages = chatMessages(after.turns, opening, null);

    // The engine's greeting is left out; the first question and the reply keep their key and text.
    const shape = ({ key, role, kind, text }: (typeof messages)[number]) => ({ key, role, kind, text });
    expect(messages.slice(0, 2).map(shape)).toEqual(before.map(shape));
    expect(messages.map((m) => m.kind)).toEqual(["question", "answer", "note", "question"]);
    expect(messages[2]?.text).toBe("Noted: knowing when something is in my way and picking up or reaching for things. I've added your note too.");
    expect(messages[3]).toMatchObject({ role: "assistant", text: "Where will you use the walker?", questionId: "places" });
  });

  it("writes the reply the way the engine records it, options in the question's order", () => {
    const ids = inQuestionOrder(opening, ["speak", "obstacles"]);
    expect(ids).toEqual(["obstacles", "speak"]);
    expect(replyText(opening, ids, "")).toBe("Knowing when something is in my way. Asking for help without typing");
    expect(replyText(opening, [], " at home ")).toBe("at home");
  });
});
