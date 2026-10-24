import type { NeedTag } from "@walker/contracts";

/**
 * Reads a user's typed words for tasks and preferences. This is a deliberately small keyword matcher:
 * the deterministic baseline the onboarding agent will be compared against, and the fallback when the
 * model is unavailable. It never looks for diagnoses or condition names, only for what the person
 * wants to do, where, and how they'd like to be told.
 *
 * A clause such as "I don't want to talk to it" declines a tag instead of adding it. Declining needs a
 * want/need/like verb or a phrase such as "rather not" or "instead of", so "I don't have a good grip"
 * still reads as wanting help picking things up.
 */

const PATTERNS: Record<NeedTag, RegExp[]> = {
  notice_obstacles: [
    /\bobstacles?\b/,
    /\bin (?:my|the) way\b/,
    /\b(?:bump|bumping|bumped|run|running|ran|walk|walking|crash|crashing)\s+into\b/,
    /\btrip(?:s|ping|ped)?\b/,
    /\bdoor ?frames?\b/,
    /\bfurniture\b/,
    /\bcurbs?\b|\bkerbs?\b/,
    /\bwhat'?s (?:in front|ahead)\b/,
  ],
  pick_up: [
    /\bpick(?:ing|s|ed)?\b(?:\s+\w+){0,2}\s+up\b/,
    /\bgrab(?:bing|s)?\b/,
    /\bgrip(?:ping|s)?\b/,
    /\bgrasp(?:ing|s)?\b/,
    /\breach(?:ing|es)?\b(?!\s+out)/,
    /\b(?:cups?|mugs?|bottles?|glasses of)\b/,
    /\brobot(?:ic)? arms?\b/,
  ],
  reach_high: [/\b(?:high|top|upper) shel(?:f|ves)\b/, /\bcupboards?\b/, /\bcabinets?\b/, /\bup high\b/],
  reach_low: [/\bfloor\b/, /\bdrop(?:s|ped|ping)?\b/, /\bbend(?:ing)? down\b/, /\blow shel(?:f|ves)\b/],
  heavy_items: [/\bheav(?:y|ier)\b/, /\bgroceries\b/, /\bshopping bags?\b/, /\blaundry\b/],
  easy_controls: [/\bbuttons?\b/, /\bcontrols?\b/, /\bfiddly\b/, /\bdexterity\b/],
  button_left: [/\bleft (?:hand|handle|side)\b/],
  button_right: [/\bright (?:hand|handle|side)\b/],
  speak_requests: [/\bspeak(?:ing)?\b/, /\btalk(?:ing)?\b/, /\bout loud\b/, /\bvoice\b/, /\bhands[- ]free\b/],
  app_requests: [/\bapp\b/, /\btyping\b/, /\btype (?:it|in|on|out)\b/],
  vibration_feedback: [/\bvibrat\w*/, /\bbuzz\w*/, /\bhaptics?\b/, /\btactile\b/],
  spoken_feedback: [/\bspoken\b/, /\bread (?:it |things )?(?:out|aloud)\b/, /\btell me\b/],
  sound_feedback: [/\bbeeps?\b/, /\bchimes?\b/, /\b(?:a|short) sounds?\b/, /\balarms?\b/],
  screen_feedback: [/\bscreen\b/, /\bdisplay\b/, /\bnotifications?\b/, /\btext on (?:a |my )?(?:phone|tablet)\b/],
  home: [/\bhome\b/, /\bhouse\b/, /\bapartment\b/, /\bindoors\b/, /\bkitchen\b/, /\bliving room\b/, /\bbedroom\b/],
  outdoors: [/\boutside\b/, /\boutdoors?\b/, /\bsidewalks?\b/, /\bpavements?\b/, /\bstreets?\b/, /\bparks?\b/, /\bpaths?\b/],
  public_places: [/\bshops?\b/, /\bstores?\b/, /\bsupermarkets?\b/, /\bmalls?\b/, /\bpublic\b/, /\blibrar(?:y|ies)\b/],
  location_sharing: [/\blocation\b/, /\bgps\b/, /\bwhere (?:i am|i'm|the walker is|it is)\b/, /\btrack(?:ing)? (?:me|it|the walker)\b/],
  walker_only: [/\bjust the walker\b/, /\bonly the walker\b/, /\bnothing (?:else|extra)\b/, /\bkeep it simple\b/],
};

const DECLINE =
  /\b(?:(?:don'?t|do not|doesn'?t|does not|won'?t|wouldn'?t|would not|never)\s+(?:really\s+)?(?:want|need|like|use|care for|wish)|rather not|not interested|no need|no thanks|without|instead of|rather than)\b/;

export interface MatchResult {
  tags: NeedTag[];
  declined_tags: NeedTag[];
}

export function matchNeeds(text: string): MatchResult {
  const normalized = text.toLowerCase().replace(/[‘’]/g, "'");
  const clauses = normalized.split(/[.!?;,]|\bbut\b|\band\b|\bor\b/);
  const tags = new Set<NeedTag>();
  const declined = new Set<NeedTag>();

  for (const clause of clauses) {
    const decline = DECLINE.exec(clause);
    for (const [tag, patterns] of Object.entries(PATTERNS) as [NeedTag, RegExp[]][]) {
      for (const pattern of patterns) {
        const hit = pattern.exec(clause);
        if (!hit) continue;
        // A decline phrase only applies to what comes after it: "out loud instead of typing".
        if (decline && decline.index < hit.index) declined.add(tag);
        else tags.add(tag);
        break;
      }
    }
  }
  for (const tag of declined) tags.delete(tag);
  return { tags: [...tags], declined_tags: [...declined] };
}
