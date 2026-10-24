import { describe, expect, it } from "vitest";
import { MODULE_CATALOG, checkSelection, type SessionView, type TurnInput } from "@walker/contracts";
import { MemorySessionStore, OnboardingError, OnboardingService, defaultSelection, openingQuestion } from "../src";
import { QUESTIONS } from "../src/onboarding/questions";

function setup(start = new Date("2026-10-23T17:00:00Z")) {
  let now = start;
  let n = 0;
  const clock = () => now;
  const service = new OnboardingService(new MemorySessionStore(clock), {
    now: clock,
    randomId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
  return { service, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

async function begin(service: OnboardingService) {
  const { token, response } = await service.start({ input_mode: "text", consent: { demo_data_notice: true } });
  return { token: token!, id: response.session.session_id, view: response.session };
}

let turnCounter = 0;
async function send(service: OnboardingService, id: string, token: string, view: SessionView, input: TurnInput) {
  const client_turn_id = `10000000-0000-4000-8000-${String(++turnCounter).padStart(12, "0")}`;
  return service.turn(id, { token }, { client_turn_id, last_seen_revision: view.revision, input });
}

describe("onboarding service", () => {
  it("starts at the first question with nothing recommended beyond the walker", async () => {
    const { service } = setup();
    const { view } = await begin(service);
    expect(view.state).toBe("collecting");
    expect(view.current_question?.id).toBe("tasks");
    expect(defaultSelection(view.recommendations)).toEqual(["base.walker"]);
  });

  it("shows the same opening question before a session exists as the session starts with", async () => {
    const { service } = setup();
    const { view } = await begin(service);
    expect(openingQuestion()).toEqual(view.current_question);
  });

  it("walks the questions, asks about reaching only when relevant, and recommends from answers", async () => {
    const { service } = setup();
    let { id, token, view } = await begin(service);
    const answers: Record<string, string[]> = {
      tasks: ["obstacles", "reach"],
      places: ["home", "outdoors"],
      feedback: ["vibration"],
      start_request: ["left"],
      reach_detail: ["high"],
      location: ["unsure"],
      anything_else: ["nothing"],
    };
    const asked: string[] = [];
    while (view.current_question) {
      const q = view.current_question;
      asked.push(q.id);
      const r = await send(service, id, token, view, { type: "answer", question_id: q.id, option_ids: answers[q.id]! });
      view = r.session;
    }
    expect(asked).toEqual(["tasks", "places", "feedback", "start_request", "reach_detail", "location", "anything_else"]);
    expect(view.state).toBe("review");

    const status = Object.fromEntries(view.recommendations.map((r) => [r.module_id, r.status]));
    expect(status).toEqual({
      "base.walker": "required",
      "controls.hand": "recommended",
      "perception.tof": "recommended",
      voice: "not_suggested",
      "manipulation.arm": "consider",
      "manipulation.lift": "consider",
      "location.gps": "unavailable",
    });
    // Every reason that cites a fact cites one that exists.
    const factIds = new Set(view.facts.map((f) => f.id));
    for (const r of view.recommendations) for (const reason of r.reasons) if (reason.fact_id) expect(factIds.has(reason.fact_id)).toBe(true);
    expect(view.recommendations.find((r) => r.module_id === "perception.tof")?.notes.join(" ")).toMatch(/outside/);
  });

  it("skips the reaching question when nobody asked for it", async () => {
    const { service } = setup();
    let { id, token, view } = await begin(service);
    const r = await send(service, id, token, view, { type: "answer", question_id: "tasks", option_ids: ["controls"] });
    view = r.session;
    expect(r.ack).toBe("Got it, buttons that are easy to press.");
    const next = await send(service, id, token, r.session, { type: "answer", question_id: "places", option_ids: ["home"] });
    const cue = await send(service, id, token, next.session, { type: "answer", question_id: "feedback", option_ids: ["vibration"] });
    expect(cue.ack).toBe("Sounds good, a buzz in the handles.");
    expect(view.progress.total).toBe(QUESTIONS.length - 1);
  });

  it("returns the same result for a retried turn and rejects a stale revision", async () => {
    const { service } = setup();
    const { id, token, view } = await begin(service);
    const request = {
      client_turn_id: "20000000-0000-4000-8000-000000000001",
      last_seen_revision: view.revision,
      input: { type: "answer", question_id: "tasks", option_ids: ["obstacles"] } as TurnInput,
    };
    const first = await service.turn(id, { token }, request);
    const retry = await service.turn(id, { token }, request);
    expect(retry).toBe(first);
    await expect(
      service.turn(id, { token }, { ...request, client_turn_id: "20000000-0000-4000-8000-000000000002" }),
    ).rejects.toMatchObject({ code: "revision_conflict", status: 409 });
  });

  it("hides sessions from callers without the token and deletes idle ones", async () => {
    const { service, advance } = setup();
    const { id, token, view } = await begin(service);
    await expect(service.get(id, { token: "wrong" })).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(service.get(id, {})).rejects.toBeInstanceOf(OnboardingError);
    advance(59 * 60 * 1000);
    await expect(service.get(id, { token })).resolves.toBeDefined();
    // The demo store deletes a session's data once it expires, so it reads the same as an unknown id.
    advance(2 * 60 * 1000);
    await expect(send(service, id, token, view, { type: "skip", question_id: "tasks" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("re-reads an edited fact and drops a removed one, with recommendations following", async () => {
    const { service } = setup();
    let { id, token, view } = await begin(service);
    view = (await send(service, id, token, view, { type: "text", text: "I keep bumping into furniture" })).session;
    const fact = view.facts[0]!;
    expect(fact.source).toBe("typed");
    expect(view.recommendations.find((r) => r.module_id === "perception.tof")?.status).toBe("recommended");

    view = (await service.editProfile(id, { token }, { last_seen_revision: view.revision, edit: { type: "update", fact_id: fact.id, text: "I want to pick up cups" } })).session;
    expect(view.facts[0]).toMatchObject({ source: "edited", tags: ["pick_up"] });
    expect(view.recommendations.find((r) => r.module_id === "perception.tof")?.status).toBe("not_suggested");

    view = (await service.editProfile(id, { token }, { last_seen_revision: view.revision, edit: { type: "remove", fact_id: fact.id } })).session;
    expect(view.facts).toEqual([]);
  });

  it("can change an earlier answer, and prunes questions that stop applying", async () => {
    const { service } = setup();
    let { id, token, view } = await begin(service);
    view = (await send(service, id, token, view, { type: "answer", question_id: "tasks", option_ids: ["reach"] })).session;
    view = (await send(service, id, token, view, { type: "skip_rest" })).session;
    expect(view.state).toBe("review");
    expect(view.progress.total).toBe(QUESTIONS.length);

    view = (await send(service, id, token, view, { type: "revisit", question_id: "tasks" })).session;
    expect(view.current_question?.id).toBe("tasks");
    view = (await send(service, id, token, view, { type: "answer", question_id: "tasks", option_ids: ["walker_only"] })).session;
    expect(view.state).toBe("review");
    expect(view.progress.total).toBe(QUESTIONS.length - 1);
  });

  it("saves a valid selection once and rejects an invalid one", async () => {
    const { service } = setup();
    let { id, token, view } = await begin(service);
    view = (await send(service, id, token, view, { type: "skip_rest" })).session;
    await expect(
      service.confirm(id, { token }, { last_seen_revision: view.revision, selected_module_ids: ["base.walker", "manipulation.lift"] }),
    ).rejects.toMatchObject({ code: "invalid_selection", status: 422 });

    view = (await service.confirm(id, { token }, { last_seen_revision: view.revision, selected_module_ids: ["voice", "base.walker"] })).session;
    expect(view.state).toBe("confirmed");
    expect(view.configuration).toMatchObject({ configuration_version: 1, selected_module_ids: ["base.walker", "voice"], source: "demo" });
    await expect(send(service, id, token, view, { type: "skip_rest" })).rejects.toMatchObject({ code: "session_confirmed" });
  });

  it("pre-selects a valid configuration for every combination of chosen options", async () => {
    const { service } = setup();
    const tasks = QUESTIONS.find((q) => q.id === "tasks")!.options.map((o) => o.id);
    const feedback = QUESTIONS.find((q) => q.id === "feedback")!.options.map((o) => o.id);
    const subsets = <T,>(xs: T[]) => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
    for (const t of subsets(tasks).filter((s) => s.length > 0)) {
      for (const f of subsets(feedback)) {
        let { id, token, view } = await begin(service);
        view = (await send(service, id, token, view, { type: "answer", question_id: "tasks", option_ids: t })).session;
        view = (await send(service, id, token, view, { type: "skip", question_id: "places" })).session;
        view = f.length
          ? (await send(service, id, token, view, { type: "answer", question_id: "feedback", option_ids: f })).session
          : (await send(service, id, token, view, { type: "skip", question_id: "feedback" })).session;
        const selection = defaultSelection(view.recommendations);
        expect(checkSelection(MODULE_CATALOG, selection), `${t} / ${f}`).toEqual([]);
        expect(view.recommendations.find((r) => r.module_id === "manipulation.arm")?.status).not.toBe("recommended");
      }
    }
  });
});
