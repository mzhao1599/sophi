import type { NeedTag, Question, QuestionId } from "@walker/contracts";

/**
 * The deterministic question bank. Questions ask about tasks, places and preferences; none asks for
 * a diagnosis. Each option records a fact in the user's own terms plus the tags it stands for, so a
 * recommendation can always point back to what the user chose.
 */

export interface OptionDefinition {
  id: string;
  label: string;
  /** Written as a note to the user ("You'd like…"); shown under "What I understood". */
  fact: string | null;
  tags: NeedTag[];
  declined_tags?: NeedTag[];
}

export interface QuestionDefinition extends Omit<Question, "options"> {
  options: OptionDefinition[];
  /** Asked only when this returns true for the tags gathered from the other questions. */
  appliesWhen?: (tags: ReadonlySet<NeedTag>) => boolean;
}

export const QUESTIONS: readonly QuestionDefinition[] = [
  {
    id: "tasks",
    prompt: "What would you like help with?",
    detail: "Choose any that fit, or put it in your own words. You don't need to share a diagnosis.",
    selection: "multiple",
    text_label: "Or describe it in your own words",
    options: [
      {
        id: "obstacles",
        label: "Knowing when something is in my way",
        fact: "You'd like to know when something is in the way",
        tags: ["notice_obstacles"],
      },
      {
        id: "reach",
        label: "Picking up or reaching for things",
        fact: "You'd like help picking things up or reaching for them",
        tags: ["pick_up"],
      },
      {
        id: "controls",
        label: "Controls without small, fiddly buttons",
        fact: "Small, fiddly buttons are hard to use, so you'd like large controls",
        tags: ["easy_controls"],
      },
      {
        id: "speak",
        label: "Asking for help without typing",
        fact: "You'd like to ask for help out loud instead of typing",
        tags: ["speak_requests"],
      },
      {
        id: "walker_only",
        label: "Just the walker for now",
        fact: "You'd like to start with just the walker",
        tags: ["walker_only"],
      },
    ],
  },
  {
    id: "places",
    prompt: "Where will you use the walker?",
    detail: "This changes which sensors make sense and what they can and can't do. Choose all that apply.",
    selection: "multiple",
    text_label: "Or name the places",
    options: [
      { id: "home", label: "At home", fact: "You'll use the walker at home", tags: ["home"] },
      {
        id: "outdoors",
        label: "Outside, on sidewalks and paths",
        fact: "You'll use the walker outside, on sidewalks and paths",
        tags: ["outdoors"],
      },
      {
        id: "public",
        label: "In shops and public buildings",
        fact: "You'll use the walker in shops and public buildings",
        tags: ["public_places"],
      },
    ],
  },
  {
    id: "feedback",
    prompt: "What's easiest for you to notice?",
    detail: "For when the walker needs your attention, such as something close in front of you.",
    selection: "multiple",
    text_label: "Or describe what works for you",
    options: [
      {
        id: "vibration",
        label: "A vibration in the handles",
        fact: "A vibration in the handles is easy for you to notice",
        tags: ["vibration_feedback"],
      },
      {
        id: "spoken",
        label: "A spoken message",
        fact: "A spoken message is easy for you to notice",
        tags: ["spoken_feedback"],
      },
      { id: "sound", label: "A short sound", fact: "A short sound is easy for you to notice", tags: ["sound_feedback"] },
      {
        id: "screen",
        label: "Text on a phone or tablet",
        fact: "Text on a phone or tablet is easy for you to notice",
        tags: ["screen_feedback"],
      },
    ],
  },
  {
    id: "start_request",
    prompt: "How would you like to ask for help?",
    detail: "This is how you'd start a request to the walker's assistant. Choose any you'd use.",
    selection: "multiple",
    text_label: "Or describe another way",
    options: [
      {
        id: "left",
        label: "Press a button on the left handle",
        fact: "You'd start a request with a button on the left handle",
        tags: ["button_left"],
      },
      {
        id: "right",
        label: "Press a button on the right handle",
        fact: "You'd start a request with a button on the right handle",
        tags: ["button_right"],
      },
      {
        id: "voice",
        label: "Say it out loud",
        fact: "You'd start a request by saying it out loud",
        tags: ["speak_requests"],
      },
      {
        id: "app",
        label: "Type it in the app on my phone",
        fact: "You'd start a request by typing in the app",
        tags: ["app_requests"],
      },
    ],
  },
  {
    id: "reach_detail",
    prompt: "What would you like to reach?",
    detail: "The robot arms are experimental and are meant for light objects in a tested area.",
    selection: "multiple",
    text_label: "Or describe what and where",
    appliesWhen: (tags) => tags.has("pick_up") || tags.has("reach_high") || tags.has("reach_low"),
    options: [
      {
        id: "table",
        label: "Light things on a table, like a cup",
        fact: "You'd like to reach light things on a table, like a cup",
        tags: ["pick_up"],
      },
      {
        id: "high",
        label: "Things on a high shelf",
        fact: "You'd like to reach things on a high shelf",
        tags: ["pick_up", "reach_high"],
      },
      {
        id: "floor",
        label: "Things that fell on the floor",
        fact: "You'd like to pick up things that fell on the floor",
        tags: ["pick_up", "reach_low"],
      },
      {
        id: "heavy",
        label: "Heavier things, like a shopping bag",
        fact: "You'd like help with heavier things, like a shopping bag",
        tags: ["heavy_items"],
      },
    ],
  },
  {
    id: "location",
    prompt: "Share where the walker is?",
    detail: "For example with a family member you choose. This isn't built yet; we'll note your answer.",
    selection: "single",
    text_label: "Or tell us more",
    options: [
      {
        id: "yes",
        label: "Yes, that would help",
        fact: "You'd like someone you trust to be able to see where the walker is",
        tags: ["location_sharing"],
      },
      {
        id: "no",
        label: "No, thanks",
        fact: "You don't want to share the walker's location",
        tags: [],
        declined_tags: ["location_sharing"],
      },
      {
        id: "unsure",
        label: "I'm not sure yet",
        fact: "You haven't decided about sharing the walker's location",
        tags: [],
      },
    ],
  },
  {
    id: "anything_else",
    prompt: "Anything else we should know?",
    detail: "Something you'd like help with, or something you don't want the walker to do.",
    selection: "single",
    text_label: "Write it here",
    options: [{ id: "nothing", label: "No, that's everything", fact: null, tags: [] }],
  },
];

/** The tags a question's options stand for, wanted or declined: what an answer to it is about. */
export function topicTags(id: QuestionId): Set<NeedTag> {
  return new Set(getQuestion(id).options.flatMap((o) => [...o.tags, ...(o.declined_tags ?? [])]));
}

export function getQuestion(id: QuestionId): QuestionDefinition {
  const q = QUESTIONS.find((x) => x.id === id);
  if (!q) throw new Error(`Unknown question ${id}`);
  return q;
}

/** The public shape: option definitions without their facts and tags. */
export function toQuestionView(q: QuestionDefinition): Question {
  return {
    id: q.id,
    prompt: q.prompt,
    detail: q.detail,
    selection: q.selection,
    text_label: q.text_label,
    options: q.options.map(({ id, label }) => ({ id, label })),
  };
}
