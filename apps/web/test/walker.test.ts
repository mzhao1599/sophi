import { describe, expect, it } from "vitest";
import { MemorySessionStore, OnboardingService } from "@walker/cloud-api";
import { MODULE_CATALOG, type ModuleId, type SessionView, type TurnInput } from "@walker/contracts";
import {
  countLine,
  heardSummary,
  partStates,
  selectedModules,
  selectionProblems,
  stateLabel,
  suggestionNews,
  toggleModule,
  whySuggested,
  type Choices,
} from "@/lib/walker";

// Sessions come from the real engine, so recommendations, reasons and facts have their real shapes.
async function sessionAfter(inputs: TurnInput[]): Promise<SessionView> {
  const service = new OnboardingService(new MemorySessionStore());
  const { token, response } = await service.start({ input_mode: "text", consent: { demo_data_notice: true } });
  let view = response.session;
  for (const input of inputs) {
    view = (await service.turn(view.session_id, { token }, { client_turn_id: crypto.randomUUID(), last_seen_revision: view.revision, input }))
      .session;
  }
  return view;
}

// Obstacles and reaching, at home, vibration cues, left button, a high shelf: hand controls and
// obstacle sensors are recommended; arms and lift are only "consider".
const SCRIPT: TurnInput[] = [
  { type: "answer", question_id: "tasks", option_ids: ["obstacles", "reach"], text: "I keep bumping into the door frame in the hallway" },
  { type: "answer", question_id: "places", option_ids: ["home"] },
  { type: "answer", question_id: "feedback", option_ids: ["vibration"] },
  { type: "answer", question_id: "start_request", option_ids: ["left"] },
  { type: "answer", question_id: "reach_detail", option_ids: ["high"] },
];

const SELECTABLE = MODULE_CATALOG.modules.filter((m) => m.default !== "required" && m.availability !== "deferred").map((m) => m.id);

describe("selection", () => {
  it("starts with what's required plus what's recommended, never what's only worth considering", async () => {
    const view = await sessionAfter(SCRIPT);
    const status = Object.fromEntries(view.recommendations.map((r) => [r.module_id, r.status]));
    expect(status["manipulation.arm"]).toBe("consider");
    expect(selectedModules(view.recommendations, {})).toEqual(["base.walker", "controls.hand", "perception.tof"]);
  });

  it("lets choices override suggestions, but never the frame or a module that isn't built", async () => {
    const view = await sessionAfter(SCRIPT);
    const choices: Choices = { "base.walker": false, "location.gps": true, "controls.hand": false, voice: true };
    expect(selectedModules(view.recommendations, choices)).toEqual(["base.walker", "perception.tof", "voice"]);
  });

  it("draws chosen parts on, suggestions dashed, the rest off, and location as not available", async () => {
    const view = await sessionAfter(SCRIPT);
    const states = partStates(view.recommendations, selectedModules(view.recommendations, {}));
    expect(states).toEqual({
      "base.walker": "on",
      "controls.hand": "on",
      "perception.tof": "on",
      voice: "off",
      "manipulation.arm": "suggested",
      "manipulation.lift": "suggested",
      "location.gps": "unavailable",
    });
  });

  it("follows the suggestions before a session exists: only the frame", () => {
    expect(selectedModules([], {})).toEqual(["base.walker"]);
    expect(partStates([], ["base.walker"])["location.gps"]).toBe("unavailable");
  });
});

describe("toggleModule", () => {
  it("won't switch off the frame or switch on location sharing, and says why", async () => {
    const { recommendations: recs } = await sessionAfter(SCRIPT);
    const frame = toggleModule(recs, {}, "base.walker", false);
    expect(frame.changed).toBe(false);
    expect(frame.selected).toContain("base.walker");
    expect(frame.message).toBe("Walker and coordinator: Part of every walker, so it stays on.");
    const gps = toggleModule(recs, {}, "location.gps", true);
    expect(gps.changed).toBe(false);
    expect(gps.selected).not.toContain("location.gps");
    expect(gps.message).toMatch(/Not available yet/);
  });

  it("adds the arms with the lift, and says so", async () => {
    const { recommendations: recs } = await sessionAfter(SCRIPT);
    const r = toggleModule(recs, {}, "manipulation.lift", true);
    expect(r.selected).toEqual(["base.walker", "controls.hand", "perception.tof", "manipulation.arm", "manipulation.lift"]);
    expect(r.alsoChanged).toEqual(["manipulation.arm"]);
    expect(r.message).toBe("Added Arm lift. Robot arms added too, because arm lift needs them.");
    expect(selectionProblems(r.selected)).toEqual([]);
  });

  it("removes the lift with the arms, and says so", async () => {
    const { recommendations: recs } = await sessionAfter(SCRIPT);
    const on = toggleModule(recs, {}, "manipulation.lift", true);
    const off = toggleModule(recs, on.choices, "manipulation.arm", false);
    expect(off.selected).toEqual(["base.walker", "controls.hand", "perception.tof"]);
    expect(off.alsoChanged).toEqual(["manipulation.lift"]);
    expect(off.message).toBe("Removed Robot arms. Arm lift removed too, because it needs robot arms.");
  });

  it("leaves a 'needs one of' choice to the person and reports it", async () => {
    const { recommendations: recs } = await sessionAfter(SCRIPT);
    const r = toggleModule(recs, {}, "controls.hand", false);
    expect(r.selected).toEqual(["base.walker", "perception.tof"]);
    expect(r.alsoChanged).toEqual([]);
    expect(selectionProblems(r.selected)).toEqual([
      {
        code: "requires_any_of",
        module_id: "perception.tof",
        needs: ["controls.hand", "voice"],
        message: "Obstacle sensors needs a way to reach you: add hand controls or voice.",
      },
    ]);
    const fixed = toggleModule(recs, r.choices, "voice", true);
    expect(selectionProblems(fixed.selected)).toEqual([]);
  });

  it("never leaves a requires, required or not-selectable problem, from any starting selection", async () => {
    const { recommendations: recs } = await sessionAfter(SCRIPT);
    for (let mask = 0; mask < 2 ** SELECTABLE.length; mask++) {
      const start: Choices = Object.fromEntries(SELECTABLE.map((id, i) => [id, Boolean(mask & (1 << i))]));
      const startHard = selectionProblems(selectedModules(recs, start)).filter((p) => p.code !== "requires_any_of");
      if (startHard.length > 0) continue; // e.g. lift without arms: not a state the switches can reach
      for (const m of MODULE_CATALOG.modules) {
        for (const on of [true, false]) {
          const r = toggleModule(recs, start, m.id, on);
          const hard = selectionProblems(r.selected).filter((p) => p.code !== "requires_any_of");
          expect(hard, `${m.id} ${on ? "on" : "off"} from ${JSON.stringify(start)}`).toEqual([]);
          if (!r.changed) continue;
          expect(r.selected.includes(m.id), m.id).toBe(on);
        }
      }
    }
  });

  it("counts the modules on the walker", () => {
    expect(countLine(["base.walker"])).toBe("1 module on your walker");
    expect(countLine(["base.walker", "voice"] as ModuleId[])).toBe("2 modules on your walker");
  });
});

describe("module panel text", () => {
  it("explains a suggestion with its reason and the person's own words", async () => {
    const view = await sessionAfter(SCRIPT);
    const tof = view.recommendations.find((r) => r.module_id === "perception.tof");
    expect(whySuggested(tof, view.facts)).toEqual({
      reason: "Sensors at the front give you a cue when something is close.",
      because: "You'd like to know when something is in the way",
    });
    const voice = view.recommendations.find((r) => r.module_id === "voice");
    expect(whySuggested(voice, view.facts)).toBeNull();
  });

  it("labels each state for the chat and for review", async () => {
    const view = await sessionAfter(SCRIPT);
    const states = partStates(view.recommendations, selectedModules(view.recommendations, {}));
    const label = (id: ModuleId, review: boolean) => stateLabel(id, states[id], review);
    expect(label("base.walker", false)).toBe("Always included");
    expect(label("perception.tof", false)).toBe("Suggested");
    expect(label("perception.tof", true)).toBe("On your walker");
    expect(label("manipulation.arm", false)).toBe("Worth considering");
    expect(label("manipulation.arm", true)).toBe("Suggested, off");
    expect(label("voice", false)).toBe("Not yet");
    expect(label("location.gps", true)).toBe("Not available yet");
    // Before a session there are no recommendations, and the frame is still always there.
    expect(stateLabel("base.walker", partStates([], ["base.walker"])["base.walker"], false)).toBe("Always included");
  });
});

describe("announcements and summary", () => {
  it("says what lit up and what went out, and nothing when nothing changed", () => {
    expect(suggestionNews(["base.walker"], ["base.walker", "controls.hand", "perception.tof"])).toBe(
      "Lit up on your walker: Hand controls and Obstacle sensors.",
    );
    expect(suggestionNews(["base.walker", "voice"], ["base.walker"])).toBe("No longer suggested: Voice.");
    expect(suggestionNews(["base.walker"], ["base.walker"])).toBeNull();
  });

  it("groups what was heard under each question, quoting typed words", async () => {
    const view = await sessionAfter(SCRIPT.slice(0, 2));
    expect(heardSummary(view.facts, view.turns)).toEqual([
      {
        questionId: "tasks",
        prompt: "Hi! What would you like a hand with?",
        items: [
          "You'd like to know when something is in the way",
          "You'd like help picking things up or reaching for them",
          "“I keep bumping into the door frame in the hallway”",
        ],
      },
      { questionId: "places", prompt: "Where will you be using your walker?", items: ["You'll use the walker at home"] },
    ]);
  });
});
