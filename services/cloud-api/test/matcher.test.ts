import { describe, expect, it } from "vitest";
import { matchNeeds } from "../src/onboarding/matcher";
import { QUESTIONS } from "../src/onboarding/questions";

describe("matchNeeds", () => {
  it.each([
    ["I keep bumping into the door frame", ["notice_obstacles"]],
    ["I can't grip my coffee mug", ["pick_up"]],
    ["I don't have a good grip", ["pick_up"]],
    ["Picking things up off the floor", ["pick_up", "reach_low"]],
    ["Small buttons are hard for me", ["easy_controls"]],
    ["A buzz in the handle would be best", ["vibration_feedback"]],
    ["I go to the supermarket and the park", ["public_places", "outdoors"]],
  ])("reads %j", (text, expected) => {
    expect(matchNeeds(text).tags.sort()).toEqual([...expected].sort());
  });

  it("declines what comes after a negative want", () => {
    expect(matchNeeds("I don't want to talk to it")).toEqual({ tags: [], declined_tags: ["speak_requests"] });
    expect(matchNeeds("Out loud instead of typing")).toEqual({ tags: ["speak_requests"], declined_tags: ["app_requests"] });
  });

  it("does not treat diagnosis words as needs", () => {
    expect(matchNeeds("I have arthritis and low vision").tags).toEqual([]);
  });

  it("handles curly apostrophes", () => {
    expect(matchNeeds("I don’t want location tracking of me").declined_tags).toContain("location_sharing");
  });

  it("reads every option's fact back to the option's own tags", () => {
    for (const q of QUESTIONS) {
      for (const o of q.options) {
        if (!o.fact || o.tags.length === 0) continue;
        expect(matchNeeds(o.fact).tags, `${q.id}.${o.id}: ${o.fact}`).toEqual(expect.arrayContaining(o.tags));
      }
    }
  });
});
