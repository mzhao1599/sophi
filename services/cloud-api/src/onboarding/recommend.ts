import type { ModuleCatalog, ModuleId, NeedTag, ProfileFact, Recommendation } from "@walker/contracts";

/**
 * Turns reviewed facts into module recommendations. Every reason names the fact it came from, every
 * module in the catalog gets an entry (so the user can still add one nobody suggested), and the robot
 * arms are only ever "consider": the most experimental module is never a default.
 */

export function activeTags(facts: readonly ProfileFact[]): Set<NeedTag> {
  const tags = new Set<NeedTag>();
  const declined = new Set<NeedTag>();
  for (const f of facts) {
    f.tags.forEach((t) => tags.add(t));
    f.declined_tags.forEach((t) => declined.add(t));
  }
  declined.forEach((t) => tags.delete(t));
  return tags;
}

type Reason = Recommendation["reasons"][number];

export function recommend(catalog: ModuleCatalog, facts: readonly ProfileFact[]): Recommendation[] {
  const tags = activeTags(facts);
  const has = (t: NeedTag) => tags.has(t);
  const factFor = (t: NeedTag) => facts.find((f) => f.tags.includes(t) && !f.declined_tags.includes(t)) ?? null;
  const declinedBy = (t: NeedTag) => facts.find((f) => f.declined_tags.includes(t)) ?? null;
  const because = (t: NeedTag, text: string): Reason[] => {
    const f = factFor(t);
    return f && has(t) ? [{ text, fact_id: f.id }] : [];
  };
  const nothingYet: Reason = { text: "Nothing you've said points to this. You can still add it.", fact_id: null };

  const build: Record<ModuleId, () => Recommendation> = {
    "base.walker": () => ({
      module_id: "base.walker",
      status: "required",
      reasons: [
        {
          text: "Every setup starts here: the frame, battery, stop switch and the coordinator that runs the other modules.",
          fact_id: null,
        },
      ],
      notes: has("walker_only") ? ["You'd like to start with just the walker. Everything else is optional."] : [],
    }),

    "controls.hand": () => {
      const reasons = [
        ...because("easy_controls", "Large buttons and a trigger on the handles are easier to press than small controls."),
        ...because("button_left", "You'd start requests from the left handle, which is where these buttons sit."),
        ...because("button_right", "You'd start requests from the right handle, which is where these buttons sit."),
        ...because("vibration_feedback", "Cues can reach you as a vibration in the handles."),
      ];
      if (reasons.length > 0) {
        const oneSide = has("button_left") !== has("button_right");
        return {
          module_id: "controls.hand",
          status: "recommended",
          reasons,
          notes: oneSide ? [`You can start with just the ${has("button_left") ? "left" : "right"} handle.`] : [],
        };
      }
      // Obstacle sensors need a cue path; with no spoken or sound preference, the handles are it.
      const needsCueOutput = has("notice_obstacles") && !has("spoken_feedback") && !has("sound_feedback");
      if (needsCueOutput) {
        return {
          module_id: "controls.hand",
          status: "recommended",
          reasons: because("notice_obstacles", "Obstacle cues need a way to reach you, and a vibration in the handles is one."),
          notes: [],
        };
      }
      return { module_id: "controls.hand", status: "not_suggested", reasons: [nothingYet], notes: [] };
    },

    "perception.tof": () => {
      if (has("notice_obstacles")) {
        const notes: string[] = [];
        if (has("outdoors")) {
          notes.push("You'll use it outside. Range in bright light hasn't been measured yet, so outdoor cues may be less reliable.");
        }
        if (!has("vibration_feedback") && !has("spoken_feedback") && !has("sound_feedback")) {
          notes.push("It needs hand controls or voice to reach you.");
        }
        return {
          module_id: "perception.tof",
          status: "recommended",
          reasons: because("notice_obstacles", "Sensors at the front give you a cue when something is close."),
          notes,
        };
      }
      const declined = declinedBy("notice_obstacles");
      return {
        module_id: "perception.tof",
        status: "not_suggested",
        reasons: declined ? [{ text: "You said you don't want obstacle cues.", fact_id: declined.id }] : [nothingYet],
        notes: [],
      };
    },

    voice: () => {
      const declined = declinedBy("speak_requests");
      if (declined && !has("spoken_feedback")) {
        return {
          module_id: "voice",
          status: "not_suggested",
          reasons: [{ text: "You'd rather not speak to the walker. The app works without voice.", fact_id: declined.id }],
          notes: [],
        };
      }
      const strong = [
        ...because("speak_requests", "Press a button and ask out loud, instead of typing."),
        ...because("spoken_feedback", "Replies and cues can be spoken, and they always appear as text too."),
      ];
      if (strong.length > 0) return { module_id: "voice", status: "recommended", reasons: strong, notes: [] };
      const sound = because("sound_feedback", "Its speaker can play short sounds as cues.");
      if (sound.length > 0) {
        // With obstacle sensors and no other cue path, the speaker is how a cue reaches the user.
        const cuePath = has("notice_obstacles") && !has("vibration_feedback");
        return { module_id: "voice", status: cuePath ? "recommended" : "consider", reasons: sound, notes: [] };
      }
      return { module_id: "voice", status: "not_suggested", reasons: [nothingYet], notes: [] };
    },

    "manipulation.arm": () => {
      const declined = declinedBy("pick_up");
      if (declined) {
        return {
          module_id: "manipulation.arm",
          status: "not_suggested",
          reasons: [{ text: "You said you don't want help picking things up.", fact_id: declined.id }],
          notes: [],
        };
      }
      const reasons = [
        ...because("pick_up", "The arms can pick up a light object in an area that has been tested."),
        ...because("reach_high", "With the lift, the arms can reach toward a higher shelf."),
        ...because("reach_low", "With the lift, the arms can reach toward a lower surface."),
      ];
      if (reasons.length > 0) {
        const notes = ["It's the most experimental module, so it's something to consider rather than a default."];
        if (has("heavy_items")) notes.push("Heavier things, like a shopping bag, are beyond what the arms are meant to lift.");
        return { module_id: "manipulation.arm", status: "consider", reasons, notes };
      }
      if (has("heavy_items")) {
        return {
          module_id: "manipulation.arm",
          status: "not_suggested",
          reasons: because("heavy_items", "The arms are meant for light objects, so they may not help with heavier things."),
          notes: [],
        };
      }
      return { module_id: "manipulation.arm", status: "not_suggested", reasons: [nothingYet], notes: [] };
    },

    "manipulation.lift": () => {
      const wantsArms = has("pick_up") || has("reach_high") || has("reach_low");
      const reasons = wantsArms
        ? [
            ...because("reach_high", "The lift raises the arms toward a high shelf."),
            ...because("reach_low", "The lift lowers the arms toward a lower surface."),
          ]
        : [];
      if (reasons.length > 0) {
        return {
          module_id: "manipulation.lift",
          status: "consider",
          reasons,
          notes: has("reach_low") ? ["Whether it can reach all the way to the floor hasn't been tested yet."] : [],
        };
      }
      return { module_id: "manipulation.lift", status: "not_suggested", reasons: [nothingYet], notes: [] };
    },

    "location.gps": () => ({
      module_id: "location.gps",
      status: "unavailable",
      reasons: has("location_sharing")
        ? because("location_sharing", "You'd like someone you trust to see where the walker is. This isn't built yet, but your answer is noted.")
        : [{ text: "This isn't built yet.", fact_id: null }],
      notes: [],
    }),
  };

  return catalog.modules.map((m) => build[m.id]());
}

/** Modules selected by default on the review screen: what's required plus what's recommended. */
export function defaultSelection(recommendations: readonly Recommendation[]): ModuleId[] {
  return recommendations.filter((r) => r.status === "required" || r.status === "recommended").map((r) => r.module_id);
}
