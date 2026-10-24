import type { NeedTag, Question, QuestionId } from "@walker/contracts";

/**
 * The deterministic question bank. Questions ask about tasks, places and preferences; none asks for
 * a diagnosis. Each option records a fact in the user's own terms plus the tags it stands for, so a
 * recommendation can always point back to what the user chose.
 */

export interface OptionDefinition {
  id: string;
  /** Sent as the person's own chat message when they tap it, so it is written in the first person. */
  label: string;
  /** Said back in the acknowledgement, in the second person: "knowing what's in your way". Not part of the contract. */
  ack: string;
  /** Written as a note to the user ("You'd like…"); shown under "What I understood". */
  fact: string | null;
  tags: NeedTag[];
  declined_tags?: NeedTag[];
}

export interface QuestionDefinition extends Omit<Question, "options"> {
  options: OptionDefinition[];
  /**
   * Starts the acknowledgement of chosen options: "Got it," gives "Got it, knowing what's in your way."
   * Each question has its own, so a conversation doesn't open every reply the same way.
   */
  ack_opener: string;
  /** The acknowledgement when the person only typed. */
  typed_ack: string;
  /** The prompt when the person comes back to change this answer, if it differs (the first question greets). */
  revisit_prompt?: string;
  /**
   * What the onboarding agent reads about this topic instead of a question to quote: why we ask and
   * what a useful answer looks like. The agent writes its own question from it; `prompt` stays the
   * deterministic engine's wording (and the agent's fallback).
   */
  purpose: string;
  /** Asked only when this returns true for the tags gathered from the other questions. */
  appliesWhen?: (tags: ReadonlySet<NeedTag>) => boolean;
}

export const QUESTIONS: readonly QuestionDefinition[] = [
  {
    id: "tasks",
    purpose: "What they'd like a hand with day to day, in their own words. A useful answer names an everyday task or something that gets in their way.",
    prompt: "Hi! What would you like a hand with?",
    revisit_prompt: "What would you like a hand with?",
    detail: "Choose any that fit, or put it in your own words. You don't need to share a diagnosis.",
    selection: "multiple",
    text_label: "Or describe it in your own words",
    ack_opener: "Got it,",
    typed_ack: "Thanks, that helps.",
    options: [
      {
        id: "obstacles",
        label: "Knowing what's in my way",
        ack: "knowing what's in your way",
        fact: "You'd like to know when something is in the way",
        tags: ["notice_obstacles"],
      },
      {
        id: "reach",
        label: "Picking up or reaching for things",
        ack: "help picking things up",
        fact: "You'd like help picking things up or reaching for them",
        tags: ["pick_up"],
      },
      {
        id: "controls",
        label: "Big, easy buttons",
        ack: "buttons that are easy to press",
        fact: "Small, fiddly buttons are hard to use, so you'd like large controls",
        tags: ["easy_controls"],
      },
      {
        id: "speak",
        label: "Asking for help out loud",
        ack: "asking for help out loud",
        fact: "You'd like to ask for help out loud instead of typing",
        tags: ["speak_requests"],
      },
      {
        id: "walker_only",
        label: "Just the walker for now",
        ack: "just the walker for now",
        fact: "You'd like to start with just the walker",
        tags: ["walker_only"],
      },
    ],
  },
  {
    id: "places",
    purpose: "Where they'll mostly use the walker, since that changes which sensors make sense and how well they work.",
    prompt: "Where will you be using your walker?",
    detail: "This changes which sensors make sense and what they can and can't do. Choose all that apply.",
    selection: "multiple",
    text_label: "Or name the places",
    ack_opener: "Good to know:",
    typed_ack: "Good to know, thanks.",
    options: [
      { id: "home", label: "At home", ack: "at home", fact: "You'll use the walker at home", tags: ["home"] },
      {
        id: "outdoors",
        label: "Outside, on sidewalks and paths",
        ack: "outside",
        fact: "You'll use the walker outside, on sidewalks and paths",
        tags: ["outdoors"],
      },
      {
        id: "public",
        label: "In shops and public buildings",
        ack: "in shops and public buildings",
        fact: "You'll use the walker in shops and public buildings",
        tags: ["public_places"],
      },
    ],
  },
  {
    id: "feedback",
    purpose: "How the walker should get their attention when something needs it, such as something close in front of them.",
    prompt: "How should the walker get your attention?",
    detail: "For when the walker needs your attention, such as something close in front of you.",
    selection: "multiple",
    text_label: "Or describe what works for you",
    ack_opener: "Sounds good,",
    typed_ack: "Sounds good, thanks.",
    options: [
      {
        id: "vibration",
        label: "A vibration in the handles",
        ack: "a buzz in the handles",
        fact: "A vibration in the handles is easy for you to notice",
        tags: ["vibration_feedback"],
      },
      {
        id: "spoken",
        label: "A spoken message",
        ack: "a spoken message",
        fact: "A spoken message is easy for you to notice",
        tags: ["spoken_feedback"],
      },
      {
        id: "sound",
        label: "A short sound",
        ack: "a short sound",
        fact: "A short sound is easy for you to notice",
        tags: ["sound_feedback"],
      },
      {
        id: "screen",
        label: "Text on my phone or tablet",
        ack: "text on your phone or tablet",
        fact: "Text on a phone or tablet is easy for you to notice",
        tags: ["screen_feedback"],
      },
    ],
  },
  {
    id: "start_request",
    purpose: "How they'd like to start asking the walker's assistant for something.",
    prompt: "How would you like to ask the walker for help?",
    detail: "This is how you'd start a request to the walker's assistant. Choose any you'd use.",
    selection: "multiple",
    text_label: "Or describe another way",
    ack_opener: "All right,",
    typed_ack: "All right, thanks.",
    options: [
      {
        id: "left",
        label: "A button on the left handle",
        ack: "a button on the left handle",
        fact: "You'd start a request with a button on the left handle",
        tags: ["button_left"],
      },
      {
        id: "right",
        label: "A button on the right handle",
        ack: "a button on the right handle",
        fact: "You'd start a request with a button on the right handle",
        tags: ["button_right"],
      },
      {
        id: "voice",
        label: "Saying it out loud",
        ack: "saying it out loud",
        fact: "You'd start a request by saying it out loud",
        tags: ["speak_requests"],
      },
      {
        id: "app",
        label: "Typing in the app on my phone",
        ack: "typing in the app on your phone",
        fact: "You'd start a request by typing in the app",
        tags: ["app_requests"],
      },
    ],
  },
  {
    id: "reach_detail",
    purpose: "What they'd like help reaching or picking up, and roughly where it usually is. Only light objects are in scope.",
    prompt: "What would you like help reaching?",
    detail: "The robot arms are experimental and are meant for light objects in a tested area.",
    selection: "multiple",
    text_label: "Or describe what and where",
    ack_opener: "Okay,",
    typed_ack: "Okay, thanks.",
    appliesWhen: (tags) => tags.has("pick_up") || tags.has("reach_high") || tags.has("reach_low"),
    options: [
      {
        id: "table",
        label: "Light things on a table, like cups",
        ack: "light things on a table",
        fact: "You'd like to reach light things on a table, like a cup",
        tags: ["pick_up"],
      },
      {
        id: "high",
        label: "Things on a high shelf",
        ack: "things on a high shelf",
        fact: "You'd like to reach things on a high shelf",
        tags: ["pick_up", "reach_high"],
      },
      {
        id: "floor",
        label: "Things I've dropped on the floor",
        ack: "things you've dropped",
        fact: "You'd like to pick up things that fell on the floor",
        tags: ["pick_up", "reach_low"],
      },
      {
        id: "heavy",
        label: "Heavy things, like shopping bags",
        ack: "heavy things like shopping bags",
        fact: "You'd like help with heavier things, like a shopping bag",
        tags: ["heavy_items"],
      },
    ],
  },
  {
    id: "location",
    purpose: "Whether they'd like someone they trust to be able to see where the walker is. It isn't built yet, so their answer is only noted.",
    prompt: "Would you like to share the walker's location?",
    detail: "For example with a family member you choose. This isn't built yet; we'll note your answer.",
    selection: "single",
    text_label: "Or tell us more",
    ack_opener: "Understood,",
    typed_ack: "Understood, thanks.",
    options: [
      {
        id: "yes",
        label: "Yes, that would help",
        // Sharing isn't built, and the page doesn't show `detail`, so the reply says so.
        ack: "sharing the walker's location once that's built",
        fact: "You'd like someone you trust to be able to see where the walker is",
        tags: ["location_sharing"],
      },
      {
        id: "no",
        label: "No, thanks",
        ack: "no location sharing",
        fact: "You don't want to share the walker's location",
        tags: [],
        declined_tags: ["location_sharing"],
      },
      {
        id: "unsure",
        label: "I'm not sure yet",
        ack: "you'll decide later",
        fact: "You haven't decided about sharing the walker's location",
        tags: [],
      },
    ],
  },
  {
    id: "anything_else",
    purpose: "Anything else they want from the walker, or something they don't want it to do.",
    prompt: "Anything else I should know?",
    detail: "Something you'd like help with, or something you don't want the walker to do.",
    selection: "single",
    text_label: "Write it here",
    ack_opener: "Thanks,",
    typed_ack: "Thanks for telling me.",
    options: [{ id: "nothing", label: "No, that's everything", ack: "that's everything", fact: null, tags: [] }],
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

/** The public shape: option definitions without their facts, tags and acks. */
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
