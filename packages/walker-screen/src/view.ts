import {
  BENCH_MODE_LABEL,
  FAULT_CLEAR_SENTENCE,
  FAULT_SENTENCES,
  MODULE_CATALOG,
  REFUSAL_SENTENCES,
  VOICE_CHOICES,
  getCatalogEntry,
  helpNames,
  holdControlShown,
  type Cue,
  type Maneuver,
  type NavigatingScreen,
  type ScreenAction,
  type ScreenContent,
  type ScreenHoldDirection,
  type ScreenSettings,
  type ScreenState,
  type ShowCard,
  type SuggestionChange,
  type TextSize,
} from "@walker/contracts";
import {
  MANEUVER_WORD,
  NAV_ARROW_PX,
  NAV_SIDE_PX,
  PHASE_WORDS,
  detailLines,
  distanceWords,
  fitChars,
  minutesLeftWords,
  navColumns,
  navMap,
  navMapHeight,
  phaseLine,
  streetForLine,
  turnWordPx,
  type NavMap,
} from "./navigation";
import { MAX_BUTTONS, screenSizes, type ScreenSizes } from "./sizes";

/**
 * The walker screen as a view model: a pure function of the state the Pi sent (and, for the web app's
 * Preview, a draft of her settings). It decides no behaviour. The Pi picks the state; this only words it and
 * lays it into the three fixed regions: the status strip, the one thing, and the band over the handles.
 */

export interface ViewButton {
  action: ScreenAction;
  label: string;
  /** A second, smaller line naming the handle that does the same, drawn with the handle's mark. */
  sublabel?: string;
  /** For an on/off switch: whether it is on. */
  pressed?: boolean;
  /** Shown but does nothing (Bigger at Largest). Kept focusable, with aria-disabled. */
  disabled?: boolean;
  primary: boolean;
}

export interface ViewLine {
  text: string;
  /**
   * `body` grows with her text size; `detail` is the smallest size; `message` is a member's message;
   * `caption` is Sophi's caption under a card she pulled up: the smallest size, under a hairline, so her words
   * don't read as the card's.
   */
  size: "body" | "detail" | "message" | "caption";
  /** A dashed "Simulated" tag after the text. */
  simulated?: boolean;
  /** Bold (the distance to the next turn). */
  strong?: boolean;
  /**
   * At most this many lines; the page clips anything past them with an ellipsis, a backstop for an unusually
   * wide name (the view already shortens to fit, and the shots check proves the backstop never fires on a fixture).
   */
  maxLines?: number;
}

export type PresenceShape = "filled" | "hollow" | "dashed";

/**
 * The lift's hold control: a large button she keeps her finger on while the lift moves. Shown only while a
 * hold-to-run lift target is pending or its motion runs held (`holdControlShown` in the contract). It isn't a
 * ScreenAction: the page reports it on its own route (POST /screen/hold), refreshed while held.
 */
export interface ViewHold {
  direction: ScreenHoldDirection;
  /** "Hold to raise". */
  label: string;
  /** Under the label, with the handle's mark: "and press Confirm" while the target waits for its press. */
  sublabel: string | null;
}

/**
 * Walking directions (`navigating`): the map in a left column, and the next thing to do on the right. The view's
 * `main` is the maneuver word or the phase sentence, drawn at `mainPx`; `lines` are the distance and the street
 * (or the place); `info` sits under the map. The budget is in navigation.ts.
 */
export interface NavView {
  /** The left column's width, px. */
  columnPx: number;
  /** The arrow drawn beside the word while guiding; null for a phase sentence. */
  turn: Maneuver | null;
  arrowPx: number;
  /** The main line's size: the fitted word, or the phase sentence's line. */
  mainPx: number;
  /** The phase sentence takes two lines in bold at her body size. */
  mainWraps: boolean;
  map: NavMap;
  /** Her position is the simulated one: a dashed Simulated tag on the map, and a dashed ring on her dot. */
  simulated: boolean;
  /** Under the map: the distance and time left. */
  info: ViewLine[];
}

export interface ScreenView {
  theme: "light" | "dark";
  textSize: TextSize;
  sizes: ScreenSizes;
  /** Changes when the one thing changes, so the page cross-fades then and only then (never on a clock tick). */
  sceneKey: string;
  /** The circle item on screen, for the page's "shown" report. */
  itemId: string | null;
  revision: number;
  settingsVersion: number;
  /**
   * `bench`: a dashed "Bench mode" tag (the arms and lift may move with no hardware stop; motion screens say it
   * in full). Not on the simulator, whose "Simulator" tag takes the room.
   */
  strip: { word: string; shape: PresenceShape; time: string | null; simulator: boolean; bench: boolean };
  /**
   * The main fact: at the main size, at body size for captions, or for a long motion title in bold at the body
   * size (`title`) or the smallest size (`small`). A card Sophi pulled up takes the largest of main, `message`,
   * `title` and `small` that leaves room for its lines.
   */
  main: { text: string; size: "main" | "body" | "message" | "title" | "small" | "nav" };
  lines: ViewLine[];
  /**
   * Over the left handle: the Confirm twin button, a word ("Confirm" when a press answers something, "Stop"
   * while motion runs, since any handle press stops it), or nothing.
   */
  left: { kind: "button"; button: ViewButton } | { kind: "hint"; word: "Confirm" | "Stop" } | null;
  /** Between the handles: other buttons, or short lines (a page count, the time left). */
  center: { lines: ViewLine[]; buttons: ViewButton[] };
  /** The lift's hold control, between the handles, or null (never shown otherwise). */
  hold: ViewHold | null;
  /** Over the right handle, always shown: "Talk", or "Stop" while motion runs (a Talk press stops it too). */
  right: "Talk" | "Stop";
  /** What a screen reader hears when the scene changes. */
  announce: string;
  /** Walking directions' map and layout, on `navigating` only. */
  nav: NavView | null;
}

const TEXT_SIZE_WORD: Record<TextSize, string> = { large: "Large", larger: "Larger", largest: "Largest" };
const TEXT_SIZE_ORDER: TextSize[] = ["large", "larger", "largest"];
const CUE_WORD: Record<Cue, string> = { vibration: "buzz", sound: "short sounds", spoken: "speech", screen: "screen" };

const voiceName = (id: string) => VOICE_CHOICES.find((v) => v.id === id)?.name ?? id;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "a", "a and b", "a, b and c". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "front_left" reads "Front left". */
export function zoneLabel(zone: string): string {
  return capital(zone.replace(/_/g, " "));
}

/** A zone's distance as the obstacle screen says it: 304 mm reads "30 cm". */
const centimetres = (mm: number) => `${Math.round(mm / 10)} cm`;

/** Cuts to `max` characters at a word where it can, with an ellipsis, so no line is ever clipped by the page. */
export function shorten(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  if ([...t].length <= max) return t;
  const cut = [...t].slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Caption pages for a reply: at most this many characters a page, so each page fits the screen at her text
 * size (checked by rendering every size at 800x480). Pages end at a sentence's end when the sentence fits;
 * a sentence too long for a page breaks between words (never inside one), and its last piece keeps at least
 * MIN_FRAGMENT_WORDS words, so no page starts or ends on a stray word or two. The Pi uses the same function
 * to know how many pages there are and moves `page` on as the reply is spoken.
 */
export const CAPTION_PAGE_CHARS: Record<TextSize, number> = { large: 110, larger: 75, largest: 50 };

export const MIN_FRAGMENT_WORDS = 3;

const chars = (s: string) => [...s].length;
const join = (a: string, b: string) => (a ? `${a} ${b}` : b);

/** A sentence too long for one page, in whole-word pieces of at most `budget`, the last of at least MIN_FRAGMENT_WORDS words. */
function wordPieces(sentence: string, budget: number): string[] {
  const pieces: string[][] = [[]];
  for (const word of sentence.split(" ")) {
    const last = pieces[pieces.length - 1]!;
    if (last.length && chars(join(last.join(" "), word)) > budget) pieces.push([word]);
    else last.push(word);
  }
  // Move words forward from the piece before until the last piece isn't a stray word or two.
  const last = pieces[pieces.length - 1]!;
  const before = pieces[pieces.length - 2];
  while (before && last.length < MIN_FRAGMENT_WORDS && before.length > MIN_FRAGMENT_WORDS && chars([before[before.length - 1], ...last].join(" ")) <= budget) {
    last.unshift(before.pop()!);
  }
  return pieces.map((p) => p.join(" "));
}

export function captionPages(text: string, textSize: TextSize): string[] {
  return pagesOf(text, CAPTION_PAGE_CHARS[textSize]);
}

/**
 * Caption pages for Sophi's reply while a card she pulled up is on screen (`showing`). The caption is a line
 * under the card at the smallest size at every text size, so a page is at most two lines of it: 75
 * characters, whatever her text size. The Pi pages the reply with this, not `captionPages`, while a card is up;
 * a longer caption is shortened at a word on screen, never clipped.
 */
export const SHOWING_CAPTION_CHARS = 75;

export function showingCaptionPages(text: string): string[] {
  return pagesOf(text, SHOWING_CAPTION_CHARS);
}

function pagesOf(text: string, budget: number): string[] {
  const sentences = text.trim().replace(/\s+/g, " ").match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const pages: string[] = [];
  let page = "";
  for (const sentence of sentences) {
    if (chars(join(page, sentence)) <= budget) {
      page = join(page, sentence);
      continue;
    }
    if (page) pages.push(page);
    page = "";
    if (chars(sentence) <= budget) {
      page = sentence;
      continue;
    }
    const pieces = wordPieces(sentence, budget);
    pages.push(...pieces.slice(0, -1));
    page = pieces[pieces.length - 1]!;
  }
  if (page) pages.push(page);
  return pages.length ? pages : [""];
}

/** "You said" is cut to this many characters (smallest size, one line). */
export const HEARD_CHARS = 26;

function parseLocal(localTime: string): { weekday: number; hour: number; minute: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(localTime);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  return { weekday: new Date(Date.UTC(y, mo - 1, d)).getUTCDay(), hour: h, minute: mi };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function partOfDay(hour: number): "morning" | "afternoon" | "evening" | "night" {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

/** "7:42", on a 12-hour clock, with the part of the day said in words beside it. */
export function clockWords(localTime: string): { time: string; day: string; greeting: string } | null {
  const t = parseLocal(localTime);
  if (!t) return null;
  const hour12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  const part = partOfDay(t.hour);
  return {
    time: `${hour12}:${String(t.minute).padStart(2, "0")}`,
    day: `${WEEKDAYS[t.weekday]} ${part}`,
    greeting: part === "night" ? "Hello" : `Good ${part}`,
  };
}

function presence(link: ScreenState["strip"]["link"]): { word: string; shape: PresenceShape } {
  switch (link) {
    case "online":
      return { word: "Online", shape: "filled" };
    case "offline":
      return { word: "Offline", shape: "hollow" };
    case "connecting":
      return { word: "Connecting", shape: "dashed" };
    case "unpaired":
    case "unauthorized":
      return { word: "Not set up", shape: "hollow" };
  }
}

/** The question for a suggestion, and the line under it. */
export function suggestionWords(change: SuggestionChange, current: ScreenSettings): { main: string; body: string } {
  switch (change.kind) {
    case "text_size": {
      const up = TEXT_SIZE_ORDER.indexOf(change.text_size) > TEXT_SIZE_ORDER.indexOf(current.text_size);
      return { main: up ? "Bigger text?" : "Smaller text?", body: `${TEXT_SIZE_WORD[change.text_size]} text` };
    }
    case "theme":
      return change.theme === "dark" ? { main: "Dark screen?", body: "Light words on dark" } : { main: "Light screen?", body: "Dark words on light" };
    case "greeting":
      return change.greeting_name === null
        ? { main: "No greeting?", body: "Just the clock" }
        : { main: "New name?", body: `Greet you as ${change.greeting_name}` };
    case "voice":
      return { main: "New voice?", body: `${voiceName(change.voice)}: this is how I'd sound.` };
  }
}

/** "Larger text is on." */
export function doneWords(change: SuggestionChange): string {
  switch (change.kind) {
    case "text_size":
      return `${TEXT_SIZE_WORD[change.text_size]} text is on.`;
    case "theme":
      return `${capital(change.theme)} screen is on.`;
    case "greeting":
      return change.greeting_name === null ? "No greeting now." : `Greeting: ${change.greeting_name}.`;
    case "voice":
      return `${voiceName(change.voice)} voice is on.`;
  }
}

/** Today's model offer, worded from its cues: the first alert it turns on, or fewer alerts. */
export function offerWords(fromCues: readonly Cue[], cues: readonly Cue[]): { main: string; body: string } {
  const added = cues.filter((c) => !fromCues.includes(c));
  const first = (["sound", "vibration", "spoken", "screen"] as const).find((c) => added.includes(c));
  const main = first === "sound" ? "Short sounds?" : first === "vibration" ? "Buzz alerts?" : first === "spoken" ? "Spoken alerts?" : "Fewer alerts?";
  return { main, body: `Alerts: ${listWords(cues.map((c) => CUE_WORD[c]))}` };
}

const confirmButton = (label = "Confirm"): ViewButton => ({
  action: label === "Confirm" ? "confirm" : "read_message",
  label,
  ...(label === "Confirm" ? {} : { sublabel: "Confirm" }),
  primary: true,
});
const button = (action: ScreenAction, label: string, extra: Partial<ViewButton> = {}): ViewButton => ({ action, label, primary: false, ...extra });
const detail = (text: string): ViewLine => ({ text, size: "detail" });
const body = (text: string): ViewLine => ({ text, size: "body" });

function minutesWords(minutes: number): string {
  if (minutes <= 0) return "Less than a minute";
  if (minutes === 1) return "About a minute";
  return `About ${minutes} minutes`;
}

interface Scene {
  key: string;
  itemId?: string;
  main: ScreenView["main"];
  lines?: ViewLine[];
  left?: ScreenView["left"];
  center?: Partial<ScreenView["center"]>;
  hold?: ViewHold | null;
  right?: ScreenView["right"];
  announce?: string;
  nav?: NavView;
}

/**
 * A screen with a row of 20 mm buttons has room for about 250 px of text: the strip (50 px) and the button row
 * (147 px) take the rest of 480. The join screen needs three lines there (the name, "Join your circle?", and
 * who invited them), which fit at Large only. At Larger and Largest the invited line moves beside the
 * buttons, in the smallest size. It is always spoken too.
 */
function besideButtonsAboveLarge(textSize: TextSize, line: string): { lines: ViewLine[]; center: ViewLine[] } {
  return textSize === "large" ? { lines: [body(line)], center: [] } : { lines: [], center: [detail(line)] };
}

function scene(content: ScreenContent, settings: ScreenSettings, state: ScreenState): Scene {
  const textSize = settings.text_size;
  switch (content.state) {
    case "obstacle": {
      const where = zoneLabel(content.zone);
      const distance = content.distance.status === "measured" ? centimetres(content.distance.mm) : "Unknown";
      return {
        key: "obstacle",
        main: { text: "Something close", size: "main" },
        lines: [{ text: `${where} · ${distance}`, size: "body", simulated: content.simulated }],
      };
    }
    case "listening":
      return { key: "listening", main: { text: "Listening", size: "main" }, lines: [body("Let go of Talk when you're done.")] };
    case "thinking":
      // Talk was let go and the answer hasn't come: words only, nothing that moves (no spinner, no dots).
      return { key: "thinking", main: { text: "One moment", size: "main" }, lines: [body("Your question is with Sophi.")] };
    case "answering": {
      // The same names as the /walker page (apps/web/src/lib/walkerView.ts). The walker's model is Claude.
      const source = content.source === "model" ? "Answered by Claude" : content.source === "fixed" ? "Answered by the fixed replies" : "On the walker, offline reply";
      const mapCredit = content.reply.startsWith("Your GPS puts you near ") ? detail("Map data © OpenStreetMap contributors") : null;
      if (!settings.captions) return { key: "answering", main: { text: "Sophi is answering", size: "main" }, lines: [detail(source)], center: { lines: mapCredit ? [mapCredit] : [] } };
      const pages = captionPages(content.reply, textSize);
      const page = Math.min(content.page, pages.length - 1);
      const lines: ViewLine[] = [];
      if (content.heard) lines.push(detail(`You said: ${shorten(content.heard, HEARD_CHARS)}`));
      lines.push(detail(source));
      return {
        key: `answering:${page}`,
        main: { text: pages[page] ?? "", size: "body" },
        lines,
        center: { lines: [pages.length > 1 ? detail(`${page + 1} of ${pages.length}`) : null, mapCredit].filter((line): line is ViewLine => line !== null) },
        announce: content.reply,
      };
    }
    case "model_offer": {
      const words = offerWords(content.from_cues, content.cues);
      return {
        key: `offer:${content.proposal_id}`,
        main: { text: words.main, size: "main" },
        // At Largest the question takes two lines, so what it changes drops to the smallest size.
        lines: [textSize === "largest" ? detail(words.body) : body(words.body)],
        left: { kind: "hint", word: "Confirm" },
        center: { lines: [detail("Offered by Sophi"), detail("About a minute")] },
      };
    }
    case "suggestion": {
      const words = suggestionWords(content.change, settings);
      return {
        key: `item:${content.item_id}`,
        itemId: content.item_id,
        main: { text: words.main, size: "main" },
        // At Largest the button row leaves room for the question and two short lines.
        lines: [textSize === "largest" ? detail(words.body) : body(words.body), detail(`From ${content.from_name}`)],
        left: { kind: "button", button: confirmButton() },
        center: {
          lines: [detail(content.one_moment ? "One moment" : minutesWords(content.minutes_left))],
          buttons: [button("not_now", "Not now")],
        },
        announce: `${words.main} ${words.body}. Suggested by ${content.from_name}. Press Confirm to do it.`,
      };
    }
    case "member_join": {
      const again = content.step === "again";
      // The name is the main line (12 characters fit one line at every size): "Let Christabelle in?" would
      // take three at Largest.
      const invited = besideButtonsAboveLarge(textSize, `${content.invited_by_name} invited ${content.name}`);
      const second = again ? { lines: [body(`to let ${content.name} in.`)], center: [] } : { lines: [body("Join your circle?"), ...invited.lines], center: invited.center };
      return {
        key: `item:${content.item_id}:${content.step}`,
        itemId: content.item_id,
        main: { text: again ? "Press again" : content.name, size: "main" },
        lines: second.lines,
        left: { kind: "button", button: confirmButton() },
        center: { lines: [...second.center, ...(content.one_moment ? [detail("One moment")] : [])], buttons: [button("not_now", "Not now")] },
        announce: again ? `Press Confirm again to let ${content.name} in.` : `${content.invited_by_name} invited ${content.name}. Let ${content.name} join your circle?`,
      };
    }
    case "done": {
      const r = content.result;
      const line =
        r.kind === "change"
          ? doneWords(r.change)
          : r.kind === "alerts"
            ? `Alerts: ${listWords(r.cues.map((c) => CUE_WORD[c]))}.`
            : r.kind === "joined"
              ? `${r.name} is in your circle.`
              : r.kind === "removed"
                ? `${r.name} is out of your circle.`
                : "";
      const nothing = r.kind === "nothing_changed";
      return {
        key: `done:${r.kind}:${line}`,
        main: { text: nothing ? "Nothing changed" : "Done", size: "main" },
        lines: line ? [body(line)] : [],
        center: { buttons: content.change_back ? [button("change_back", "Change it back")] : [] },
        announce: nothing ? "Nothing changed." : `Done. ${line}`,
      };
    }
    case "message_waiting":
      return {
        key: `message_waiting:${content.message_id}`,
        main: { text: "A message", size: "main" },
        lines: [body(`From ${content.from_name}`)],
        left: { kind: "button", button: confirmButton("Read it") },
        center: { lines: content.more > 0 ? [detail(`${content.more} more waiting`)] : [] },
        announce: `Message from ${content.from_name}. Press Confirm to read it.`,
      };
    case "message":
      // The walker reads it aloud as it shows it; a Confirm press with nothing to confirm reads it again. A hint,
      // not a touch button: the Pi doesn't act on screen presses yet, and a control that does nothing isn't shown.
      return {
        key: `message:${content.message_id}`,
        main: { text: content.text, size: "message" },
        lines: [detail(`From ${content.from_name}`)],
        left: { kind: "hint", word: "Confirm" },
        center: { lines: [detail("Press Confirm to hear it again.")] },
        announce: `${content.from_name} says: ${content.text}`,
      };
    case "navigating":
      return navigatingScene(content, textSize);
    case "showing":
      return showingScene(content, settings);
    case "offline":
      // TODO(circle piece): add back the "My screen" button here and on the clock once the Pi acts on it. A
      // control that does nothing is never shown (AGENTS.md: never present something unbuilt as working).
      return {
        key: "offline",
        main: { text: "No internet", size: "main" },
        lines: [detail("Alerts still work on the walker.")],
      };
    case "not_set_up":
      return { key: "not_set_up", main: { text: "Not set up yet", size: "main" }, lines: [body("Ask your family to set it up.")] };
    case "ambient": {
      const clock = state.strip.clock ? clockWords(state.strip.clock.local_time) : null;
      const name = settings.greeting_name;
      const lines: ViewLine[] = [];
      if (clock) {
        lines.push(body(name ? `${clock.greeting}, ${name}` : clock.day));
        if (name) lines.push(detail(clock.day));
      } else if (name) lines.push(body(`Hello, ${name}`));
      return {
        key: "ambient",
        main: { text: clock?.time ?? "Sophi", size: "main" },
        lines,
        center: {
          lines: content.alerts ? [detail(`Alerts: ${listWords(content.alerts.map((c) => CUE_WORD[c]))}`)] : [],
          // TODO(circle piece): the "My screen" button, once it does something (see "offline").
          buttons: [],
        },
      };
    }
    case "my_screen":
      return myScreen(content.view, settings);
    case "motion_confirm":
    case "motion_running":
    case "motion_holding":
    case "motion_fault":
      return motionScene(content, textSize, state.strip.bench_mode);
    case "help_hold":
    case "help_countdown":
    case "help":
      return helpScene(content, textSize);
  }
}

// ---- Asking for help (docs/subsystems/help.md, added 2026-10-24) ----

/** "Maya is" / "Maya and Sam are": the verb agrees with how many names there are. */
const agree = (names: readonly string[], one: string, more: string) => `${helpNames(names)} ${names.length === 1 ? one : more}`;

/**
 * The walker's fixed help lines, the design's table word for word (docs/subsystems/help.md, "The walker's fixed
 * lines"). The Pi speaks these (devices/pi/src/notices.ts imports them) and the help screens show them, so the two
 * never drift. Gender-neutral: the walker can't know anyone's pronouns. Calm words only (the screen's rule).
 */
export const HELP_WORDS = {
  asking: "Asking for help.",
  stopped: "Okay. I didn't ask anyone.",
  retrying: "No internet yet. I'll keep trying.",
  sent: (names: readonly string[]) => `Sent to ${helpNames(names)}'s ${names.length === 1 ? "phone" : "phones"}.`,
  /** One phone at a time: each phone that shows it is said once. */
  shown: (name: string) => `It's showing on ${name}'s phone.`,
  coming: (names: readonly string[]) => `${agree(names, "is", "are")} on the way.`,
  armOkay: (sentTo: readonly string[]) => `Press Confirm again to tell ${helpNames(sentTo)} you're okay.`,
  closedOkay: (sentTo: readonly string[]) => `Okay. ${helpNames(sentTo)} will see that you're okay.`,
  closedWithHer: (name: string) => `${name} says they're with you.`,
  expired: "Your request for help has ended.",
  notSent: {
    no_caretaker: "No caretaker's phone is linked to this walker, so nothing was sent.",
    offline: "I couldn't reach the internet, so nothing was sent. Use your phone if you can.",
    failed: "Something went wrong, so nothing was sent. Use your phone if you can.",
  },
  /** The second Confirm's /okay didn't get through (added to the design's table with it). */
  okayNotSent: "I couldn't reach the internet. Press Confirm twice to try again.",
  countdown: (seconds: number) => `Asking for help in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`,
  pressToStop: "Press any button to stop.",
} as const;

/**
 * The help screen's main line at the main size when it fits in at most two lines with the lines under it, else
 * as a motion title does (`fitMotionMain`: bold body size, then bold smallest). Names are never cut.
 */
function helpMain(text: string, textSize: TextSize, lines: readonly ViewLine[]): ScreenView["main"] {
  const sizes = screenSizes(textSize);
  const room = ONE_THING_PX.words - linesPx(lines, sizes) - 4;
  const mainLines = Math.ceil((chars(text) * CHAR_EM.bold * sizes.main) / WRAP_PX);
  if (mainLines <= 2 && Math.ceil(mainLines * sizes.main * 1.02) <= room) return { text, size: "main" };
  return fitMotionMain(text, textSize, lines, false);
}

/** A line holding names: the body size while it stays short, else the smallest size, so seven long names still fit. */
const namesLine = (text: string): ViewLine => (chars(text) <= 40 ? body(text) : detail(text));

type HelpContent = Extract<ScreenContent, { state: "help_hold" | "help_countdown" | "help" }>;

/**
 * Asking for help. Nothing here can be tapped: the handles start it, stop a countdown and say "I'm okay" (the
 * contract has no ScreenAction for help), so the band names the handles instead.
 */
function helpScene(content: HelpContent, textSize: TextSize): Scene {
  const stop = { left: { kind: "hint", word: "Stop" } as const, right: "Stop" as const };
  if (content.state === "help_hold") {
    const lines = [body("to ask for help.")];
    return {
      key: "help_hold",
      main: helpMain("Keep holding", textSize, lines),
      lines,
      center: { lines: [detail("Let go to stop.")] },
      announce: "Keep holding to ask for help. Let go to stop.",
    };
  }
  if (content.state === "help_countdown") {
    const line = HELP_WORDS.countdown(content.seconds_left);
    // One key for the whole countdown: the number changes each second without a cross-fade.
    return {
      ...stop,
      key: "help_countdown",
      main: { text: String(content.seconds_left), size: "main" },
      lines: [body(line)],
      center: { lines: [detail(HELP_WORDS.pressToStop)] },
      announce: `${line} ${HELP_WORDS.pressToStop}`,
    };
  }
  const help = content.help;
  switch (help.phase) {
    case "sending": {
      const lines = help.retrying ? [detail(HELP_WORDS.retrying)] : [];
      return { key: `help_sending:${help.retrying}`, main: helpMain("Asking for help", textSize, lines), lines };
    }
    case "not_sent": {
      const lines = [detail(HELP_WORDS.notSent[help.why])];
      return { key: `help_not_sent:${help.why}`, main: helpMain("Not sent", textSize, lines), lines, announce: `Not sent. ${HELP_WORDS.notSent[help.why]}` };
    }
    case "open": {
      const confirm = { left: { kind: "hint", word: "Confirm" } as const };
      if (help.confirm_okay) {
        const lines = [namesLine(`to tell ${helpNames(help.sent_to)} you're okay.`)];
        return { ...confirm, key: "help_open:confirm_okay", main: helpMain("Press Confirm again", textSize, lines), lines, announce: HELP_WORDS.armOkay(help.sent_to) };
      }
      // The newest news leads: coming, else showing on a phone, else sent.
      const news =
        help.coming.length > 0
          ? HELP_WORDS.coming(help.coming)
          : help.shown_to.length > 0
            ? `It's showing on ${helpNames(help.shown_to)}'s ${help.shown_to.length === 1 ? "phone" : "phones"}.`
            : HELP_WORDS.sent(help.sent_to);
      const lines = [detail("Press Confirm twice to say you're okay.")];
      return {
        ...confirm,
        key: `help_open:${help.sent_to.join(",")}:${help.shown_to.join(",")}:${help.coming.join(",")}`,
        main: helpMain(news.slice(0, -1), textSize, lines),
        lines,
        announce: `${news} Press Confirm twice to say you're okay.`,
      };
    }
    case "closed": {
      if (help.how === "okay") {
        const said = HELP_WORDS.closedOkay(help.sent_to);
        const lines = [namesLine(said.slice("Okay. ".length))];
        return { key: `help_closed:okay:${help.sent_to.join(",")}`, main: helpMain("Okay", textSize, lines), lines, announce: said };
      }
      const said = help.how === "with_her" && help.by_name ? HELP_WORDS.closedWithHer(help.by_name) : HELP_WORDS.expired;
      return { key: `help_closed:${help.how}:${help.by_name ?? ""}`, main: helpMain(said.slice(0, -1), textSize, []), announce: said };
    }
  }
}

// ---- Motion (the arms and the lift) ----

const HOLD_WORD: Record<ScreenHoldDirection, string> = { raise: "Hold to raise", lower: "Hold to lower", home: "Hold to home", move: "Hold to move" };

/**
 * Height left for the one thing (px), from the fixed regions at 800x480: 12 px of padding, the 50 px strip,
 * two 8 px gaps, and the band over the handles (a 147 px button row, or the 48 px handle words).
 */
export const ONE_THING_PX = { buttons: 480 - 12 - 50 - 16 - 147, words: 480 - 12 - 50 - 16 - 48 } as const;
/** Usable width (px) of a line, less what word wrapping wastes at the end of each line. */
const WRAP_PX = 690;
/** Average character width as a share of the font size, measured on Atkinson Hyperlegible Next (bold 0.49, regular 0.44). */
const CHAR_EM = { bold: 0.5, regular: 0.45 } as const;

/** About how tall a text is at this size: its lines (estimated from its length) times the line height. */
function heightPx(text: string, fontPx: number, weight: keyof typeof CHAR_EM, lineHeight: number): number {
  const lines = Math.max(1, Math.ceil((chars(text) * CHAR_EM[weight] * fontPx) / WRAP_PX));
  return Math.ceil(lines * fontPx * lineHeight);
}

function linesPx(lines: readonly ViewLine[], sizes: ScreenSizes): number {
  return lines.reduce((sum, l) => sum + 2 + heightPx(l.text, l.size === "detail" ? sizes.smallest : sizes.body, "regular", 1.15), 0);
}

/**
 * A motion screen's main line at the largest size that leaves room for its other lines: the main size on
 * one line, else the body size in bold (`title`), else the smallest size in bold (`small`). The Pi's words
 * are never cut. The estimate is checked by rendering every fixture, with the longest titles and sentences
 * the contract allows, at 800x480 in headless Chromium (test/shots.test.tsx).
 */
export function fitMotionMain(text: string, textSize: TextSize, lines: readonly ViewLine[], buttons: boolean): ScreenView["main"] {
  const sizes = screenSizes(textSize);
  // Less a few px for the gap after the main line and rounding (a 60-character title at Largest came 1 px over without it).
  const room = (buttons ? ONE_THING_PX.buttons : ONE_THING_PX.words) - linesPx(lines, sizes) - 4;
  const mainLines = Math.ceil((chars(text) * CHAR_EM.bold * sizes.main) / WRAP_PX);
  if (mainLines <= 1 && Math.ceil(sizes.main * 1.02) <= room) return { text, size: "main" };
  if (heightPx(text, sizes.body, "bold", 1.1) <= room) return { text, size: "title" };
  return { text, size: "small" };
}

/** What follows the title in a Confirm target's prompt: PARK_PROMPT or CONFIRM_ONLY_PROMPT (`confirmPrompt`). */
export function promptAfterTitle(title: string, prompt: string): string {
  const t = title.trim();
  const sentence = /[.?!]$/.test(t) ? t : `${t}.`;
  return prompt.startsWith(sentence) ? prompt.slice(sentence.length).trim() : prompt;
}

/** The bench label, in full, on every motion screen: there is no hardware stop. */
const benchLine = (bench: boolean): ViewLine[] => (bench ? [detail(BENCH_MODE_LABEL)] : []);

type MotionContent = Extract<ScreenContent, { state: "motion_confirm" | "motion_running" | "motion_holding" | "motion_fault" }>;

function motionScene(content: MotionContent, textSize: TextSize, bench: boolean): Scene {
  switch (content.state) {
    case "motion_confirm": {
      // No touch Confirm: only a handle Confirm press starts motion (motion.ts, THE RULE), so the left handle
      // is named and nothing over it can be tapped.
      const { target } = content;
      const direction = holdControlShown(content);
      const hold = direction ? { direction, label: HOLD_WORD[direction], sublabel: "and press Confirm" } : null;
      const lines = [detail(promptAfterTitle(target.title, target.prompt)), ...benchLine(bench)];
      return {
        key: `motion_confirm:${target.target_id}`,
        main: fitMotionMain(target.title, textSize, lines, hold !== null),
        lines,
        left: { kind: "hint", word: "Confirm" },
        hold,
        announce: hold ? `${target.prompt} Keep holding ${hold.label} on the screen while you press Confirm.` : target.prompt,
      };
    }
    case "motion_running": {
      const lift = content.lift;
      const direction = holdControlShown(content);
      const common = { left: { kind: "hint", word: "Stop" } as const, right: "Stop" as const };
      if (lift?.phase === "running") {
        // While the lift runs, the one thing she must do is keep holding: that is the main line. The button
        // under her finger names the way it goes, so the Pi's words for it are spoken, not shown.
        const lines = [detail("Let go, or press a handle button, to stop."), ...benchLine(bench)];
        return {
          ...common,
          key: "motion_running:lift",
          main: { text: "Keep holding", size: "main" },
          lines,
          hold: direction ? { direction, label: HOLD_WORD[direction], sublabel: null } : null,
          announce: `${content.what}. Keep holding. Let go, or press a handle button, to stop.`,
        };
      }
      if (lift?.phase === "stopping") {
        // A released or stopped lift never resumes, so the hold control is gone.
        return { ...common, key: "motion_running:lift:stopping", main: { text: "Stopping", size: "main" }, lines: benchLine(bench), announce: "Stopping." };
      }
      const lines = [detail("Press any handle button to stop."), ...benchLine(bench)];
      return {
        ...common,
        key: `motion_running:${content.what}`,
        main: fitMotionMain(content.what, textSize, lines, false),
        lines,
        announce: `Moving: ${content.what}. Press any handle button to stop.`,
      };
    }
    case "motion_holding": {
      const main = content.outcome === "completed" ? "Done" : content.outcome === "stopped" ? "Stopped" : "Not started";
      return {
        key: `motion_holding:${content.outcome}:${content.refusal ?? ""}`,
        main: { text: main, size: "main" },
        lines: [content.refusal ? detail(REFUSAL_SENTENCES[content.refusal]) : body("Holding still."), ...benchLine(bench)],
      };
    }
    case "motion_fault": {
      const first = FAULT_SENTENCES[content.faults[0]!];
      const more = content.faults.length - 1;
      const center = { lines: more > 0 ? [detail(`${more} more to check`)] : [] };
      if (content.confirm) {
        const lines = [detail(first), detail(promptAfterTitle(content.confirm.title, content.confirm.prompt)), ...benchLine(bench)];
        return {
          key: `motion_fault:${content.faults.join(",")}:${content.confirm.target_id}`,
          main: fitMotionMain(content.confirm.title, textSize, lines, false),
          lines,
          left: { kind: "hint", word: "Confirm" },
          center,
          announce: `${first} ${content.confirm.prompt}`,
        };
      }
      const lines = [detail(first), detail(FAULT_CLEAR_SENTENCE), ...benchLine(bench)];
      return {
        key: `motion_fault:${content.faults.join(",")}`,
        main: fitMotionMain("Stopped", textSize, lines, false),
        lines,
        center,
        announce: `Stopped. ${first} ${FAULT_CLEAR_SENTENCE}`,
      };
    }
  }
}

// ---- Walking directions ----

/**
 * The route in progress. The scene key is the phase and the instruction, so the screen cross-fades (and a screen
 * reader hears the whole instruction) only when the next thing to do changes, never as the metres count down;
 * the map and the distances still update with every state. Repeat and End route sit between the handles, and
 * act on the Pi (the service answers `repeat_direction` and `end_route` presses while a route is on).
 */
function navigatingScene(content: NavigatingScreen, textSize: TextSize): Scene {
  const guiding = content.phase === "guiding";
  const main = guiding ? MANEUVER_WORD[content.maneuver] : PHASE_WORDS[content.phase as Exclude<NavigatingScreen["phase"], "guiding">];
  const right = navColumns(textSize).right;
  const left = navColumns(textSize).left;
  const sizes = screenSizes(textSize);
  const lines: ViewLine[] = [];
  const info: ViewLine[] = [];
  let announce: string;
  if (guiding) {
    if (content.to_step_m !== null) lines.push({ text: content.to_step_m === 0 ? "Now" : `in ${distanceWords(content.to_step_m)}`, size: "body", strong: true });
    if (content.maneuver === "arrive") {
      // Arriving is the next thing: the distance beside the arrow says what is left, so the place goes under the map.
      info.push({ text: shorten(content.destination, fitChars(left, sizes.smallest, 3)), size: "detail", maxLines: 3 });
    } else {
      if (content.street) lines.push({ text: streetForLine(content.street, fitChars(right, sizes.body, 1)), size: "body", maxLines: 1 });
      info.push(detail(`${distanceWords(content.remaining_m)} to go`), detail(minutesLeftWords(content.remaining_min)));
    }
    announce = content.instruction;
  } else if (content.phase === "arrived") {
    lines.push({ text: shorten(content.destination, fitChars(right, sizes.body, 2)), size: "body", maxLines: 2 });
    announce = `${main}: ${content.destination}.`;
  } else {
    // While the route is being planned again, or can't be, its distances aren't true: only where she is going.
    lines.push({ text: shorten(`To ${content.destination}`, fitChars(right, sizes.smallest, 2)), size: "detail", maxLines: 2 });
    announce = `${main}.`;
  }
  const fitted = guiding ? { px: turnWordPx(main, textSize), wraps: false } : phaseLine(main, textSize);
  const infoLines = info.reduce((n, l) => n + Math.min(l.maxLines ?? 1, detailLines(l.text, textSize)), 0);
  return {
    key: `navigating:${content.phase}:${content.instruction}`,
    main: { text: main, size: "nav" },
    lines,
    center: { buttons: [button("repeat_direction", "Repeat"), button("end_route", "End route")] },
    announce,
    nav: {
      columnPx: left,
      turn: guiding ? content.maneuver : null,
      arrowPx: NAV_ARROW_PX[textSize],
      mainPx: fitted.px,
      mainWraps: fitted.wraps,
      map: navMap(content.map, left, NAV_SIDE_PX, navMapHeight(infoLines)),
      simulated: content.simulated,
      info,
    },
  };
}

// ---- Cards Sophi pulls up (`showing`, added 2026-10-24, docs/subsystems/show-on-screen.md) ----

/*
 * Height budget. A card has no buttons, so the one thing gets ONE_THING_PX.words: 354 px, 350 as drawn (the
 * fit keeps 4 px spare). Estimated heights below include the 2 px gap after each line; a dashed Simulated tag
 * makes a smallest-size line 8 px taller. At Largest the main line is 120 px (123 a line), the message size 80
 * (88 a line), the body 64 (76 a line) and the smallest 40 (48 a line, 94 for two).
 *
 * With captions on, a whole caption page is kept free under the card from the moment it appears, so nothing
 * moves as the pages turn or when the answer ends: two lines of the smallest size under a hairline, 104 px
 * (SHOWING_CAPTION_CHARS, 75 characters at every size). That leaves the card 246 px. Each card at Largest with
 * the longest strings the contract allows, and a full caption page (fixtures `showing-*-longest`):
 *
 *   weather   -150° at the message size 88, the 40-character conditions 48, "Wind 300 mph" 48,
 *             "Near you, from GPS" with its tag 56                                        = 240
 *             (the demo's 64° stays at the main size: 123 + 48 + 48 = 219)
 *   location  the 120-character address in bold at the smallest size, 4 lines 184, "Near you, from GPS" 56  = 240
 *   sensors   16 zones with 24-character names: the nearest in bold at the smallest size 46, one zone with
 *             its tag over two lines 102, "and 15 more, 5 not measured" 48                = 196
 *   message   the 30-character message at the message size, 2 lines 176, "From Christabelle" 48     = 224
 *   parts     16 parts: "16 parts" at the message size 88, one part with its tag over two lines 102,
 *             "and 15 more, 7 simulated" 48                                                = 238
 *
 * Between the handles, one line at the smallest size (the band's 48 px): the weather's and the map's credits.
 * Lists show as many items as fit and count the rest ("and N more"); the main line takes the largest size left.
 * The estimate is checked by drawing every fixture at 800x480 in Chromium (test/shots.test.tsx).
 */

type ShowingContent = Extract<ScreenContent, { state: "showing" }>;
type CardMainSize = "main" | "message" | "title" | "small";
type PartHealth = Extract<ShowCard, { view: "parts" }>["parts"][number]["health"];

const GPS_LINE = "Near you, from GPS";
const WEATHER_CREDIT = "Weather data from Open-Meteo";
const SAMPLE_WEATHER = "Simulated weather, not a forecast";
/** The address comes from OpenStreetMap's reverse geocoder (Nominatim), whose licence asks for this credit. */
const OSM_CREDIT = "© OpenStreetMap contributors";
const NOT_MEASURED = "Not measured";
/** The widest a distance can read (65535 mm), so a live sensors card is measured the same as its numbers change. */
const WIDEST_DISTANCE = centimetres(65_535);
const HEALTH_WORD: Record<PartHealth, string> = { ok: "Working", degraded: "Needs a check", fault: "Not working", unavailable: "Not responding" };
/** Problems first, then stand-ins, so the parts left under "and N more" are the real, working ones. */
const PART_ORDER: Record<PartHealth, number> = { fault: 0, unavailable: 1, degraded: 2, ok: 3 };
const partOrder = (p: { health: PartHealth; simulated: boolean }) => PART_ORDER[p.health] + (p.health === "ok" && !p.simulated ? 1 : 0);

/** A line width (px) up to which a line is taken as one line: the 768 px the text has, less a margin for the estimate. */
const ONE_LINE_PX = 720;
/** A dashed "Simulated" tag after a line's text: its words in bold at the smallest size, padding, border and margin. */
const TAG_PX = 226;
/** How much taller the tag's border makes a line at the smallest size (the tag is its text's height plus 6 px of border). */
const TAG_TALLER_PX = 8;
/** The caption's hairline above it, and the space around it (screen.css). */
const CAPTION_RULE_PX = 10;

function estimatedLines(text: string, fontPx: number, weight: keyof typeof CHAR_EM, extraPx = 0): number {
  const width = chars(text) * CHAR_EM[weight] * fontPx + extraPx;
  return width <= ONE_LINE_PX ? 1 : Math.ceil(width / WRAP_PX);
}

/** About how tall a main line is at each size; a main-size line over two lines doesn't fit (the screenshot check's rule). */
function mainPx(text: string, size: ScreenView["main"]["size"], sizes: ScreenSizes): number {
  // The font size, weight and line height of each main size in screen.css.
  const style: Record<ScreenView["main"]["size"], [number, keyof typeof CHAR_EM, number]> = {
    main: [sizes.main, "bold", 1.02],
    message: [sizes.message, "bold", 1.1],
    title: [sizes.body, "bold", 1.1],
    small: [sizes.smallest, "bold", 1.15],
    body: [sizes.body, "regular", 1.2],
    // The directions screen fits its turn word itself (navigation.ts, turnWordPx); no card measures it here.
    nav: [sizes.main, "bold", 1.02],
  };
  const [font, weight, lineHeight] = style[size];
  const lines = estimatedLines(text, font, weight);
  if (size === "main" && lines > 2) return Infinity;
  return Math.ceil(lines * font * lineHeight);
}

interface CardLine extends ViewLine {
  /** Measured as this text instead, so a card whose numbers change keeps its sizes. */
  sizeAs?: string;
}

function cardLinePx(line: CardLine, sizes: ScreenSizes): number {
  const small = line.size === "detail" || line.size === "caption";
  const font = small ? sizes.smallest : sizes.body;
  const taller = (line.simulated && small ? TAG_TALLER_PX : 0) + (line.size === "caption" ? CAPTION_RULE_PX : 0);
  return 2 + taller + Math.ceil(estimatedLines(line.sizeAs ?? line.text, font, "regular", line.simulated ? TAG_PX : 0) * font * 1.15);
}

/** The estimated height of a view's one thing (its main line and lines), as the cards are fitted. */
export function oneThingPx(view: Pick<ScreenView, "main" | "lines" | "sizes">): number {
  return mainPx(view.main.text, view.main.size, view.sizes) + view.lines.reduce((sum, l) => sum + cardLinePx(l, view.sizes), 0);
}

interface CardPlan {
  main: string;
  /** Measured as this text instead (the sensors card's nearest zone changes as she moves). */
  mainAs?: string;
  mainSizes: readonly CardMainSize[];
  /** The card's lines, in the order she'd want them: each is tried with its body lines, then all at the smallest size. */
  layouts: readonly (readonly CardLine[])[];
  /** `main`: the biggest main line first (a temperature, an address); `layout`: the earliest layout first (a list's length). */
  prefer: "main" | "layout";
}

/** The first of the card's layouts and main sizes, in its order of preference, that fits above the reserved caption. */
function fitCard(plan: CardPlan, sizes: ScreenSizes, reservePx: number): { main: ScreenView["main"]; lines: ViewLine[] } {
  const room = ONE_THING_PX.words - reservePx - 4;
  const modes = (layout: readonly CardLine[]) => [layout, layout.map((l): CardLine => (l.size === "body" ? { ...l, size: "detail" } : l))];
  const tries: [CardMainSize, readonly CardLine[]][] =
    plan.prefer === "main"
      ? plan.mainSizes.flatMap((m) => plan.layouts.flatMap((layout) => modes(layout).map((lines): [CardMainSize, readonly CardLine[]] => [m, lines])))
      : plan.layouts.flatMap((layout) => plan.mainSizes.flatMap((m) => modes(layout).map((lines): [CardMainSize, readonly CardLine[]] => [m, lines])));
  const px = ([m, lines]: [CardMainSize, readonly CardLine[]]) => mainPx(plan.mainAs ?? plan.main, m, sizes) + lines.reduce((sum, l) => sum + cardLinePx(l, sizes), 0);
  const [size, lines] = tries.find((t) => px(t) <= room) ?? tries[tries.length - 1]!;
  return { main: { text: plan.main, size }, lines: lines.map(({ sizeAs: _, ...line }) => line) };
}

/**
 * A list's layouts: every item, then one fewer each time with "and N more" after them. The line also says how
 * many of those it hides aren't measured (`unknown`), and how many are simulated unless every item is (then
 * the shown items' tags already say it), so nothing hidden reads as measured or real.
 */
function listLayouts(items: readonly (CardLine & { unknown?: boolean })[]): CardLine[][] {
  const allSimulated = items.every((i) => i.simulated);
  const lines = items.map(({ unknown: _, ...line }): CardLine => line);
  return items.map((_, i) => {
    const shown = items.length - i;
    if (shown === items.length) return lines;
    const hidden = items.slice(shown);
    const unknown = hidden.filter((h) => h.unknown).length;
    const simulated = allSimulated ? 0 : hidden.filter((h) => h.simulated).length;
    return [...lines.slice(0, shown), body(`and ${hidden.length} more${unknown ? `, ${unknown} not measured` : ""}${simulated ? `, ${simulated} simulated` : ""}`)];
  });
}

const degrees = (n: number) => `${n < 0 ? `minus ${-n}` : n} ${Math.abs(n) === 1 ? "degree" : "degrees"} Fahrenheit`;
const miles = (n: number) => `${n} ${n === 1 ? "mile" : "miles"} per hour`;
const spokenZone = (zone: string) => zone.replace(/_/g, " ");

/**
 * A card Sophi pulled up. The Pi built every word on it from its own data; this only lays it out. The key and
 * the announcement name what the card says, never the caption (a new page each few seconds) or, on the
 * sensors card, the readings (new ones each tenth of a second): a screen reader hears the card once, when it
 * appears, and again only when it is a different card.
 */
function showingScene(content: ShowingContent, settings: ScreenSettings): Scene {
  const sizes = screenSizes(settings.text_size);
  // With captions on, room for a whole caption page is kept from the first moment, so the card keeps its sizes
  // as the pages turn and when the answer ends.
  const reserve = settings.captions ? cardLinePx({ text: "x".repeat(SHOWING_CAPTION_CHARS), size: "caption" }, sizes) : 0;
  const caption: ViewLine[] =
    settings.captions && content.caption
      ? [{ text: chars(content.caption) <= SHOWING_CAPTION_CHARS ? content.caption : shorten(content.caption, SHOWING_CAPTION_CHARS), size: "caption" }]
      : [];
  const card = content.card;
  const cardScene = (key: string, plan: CardPlan, announce: string, center: ViewLine[] = []): Scene => {
    const fit = fitCard(plan, sizes, reserve);
    return { key: `showing:${card.view}:${key}`, main: fit.main, lines: [...fit.lines, ...caption], center: { lines: center }, announce };
  };
  switch (card.view) {
    case "weather": {
      const conditions = capital(card.conditions);
      // A simulated card is the simulator's sample weather, not Open-Meteo's: it says so and credits no one.
      const gps: CardLine[] = card.simulated ? [{ text: SAMPLE_WEATHER, size: "detail", simulated: true }] : [];
      return cardScene(
        `${card.temperature_f}:${card.conditions}:${card.wind_mph}:${card.simulated}`,
        {
          main: `${card.temperature_f}°`,
          mainSizes: ["main", "message", "title", "small"],
          layouts: [
            [body(conditions), body(`Wind ${card.wind_mph} mph`), ...gps],
            [body(`${conditions}, wind ${card.wind_mph} mph`), ...gps],
          ],
          prefer: "main",
        },
        `${degrees(card.temperature_f)}, ${card.conditions}, wind ${miles(card.wind_mph)}. ${card.simulated ? `${SAMPLE_WEATHER}.` : `${WEATHER_CREDIT}.`}`,
        card.simulated ? [] : [detail(WEATHER_CREDIT)],
      );
    }
    case "location":
      return cardScene(
        `${card.place}:${card.simulated}`,
        { main: card.place, mainSizes: ["main", "message", "title", "small"], layouts: [[{ text: GPS_LINE, size: "detail", simulated: card.simulated }]], prefer: "main" },
        `${GPS_LINE}: ${card.place}.${card.simulated ? " The location is simulated." : ""}`,
        [detail(OSM_CREDIT)],
      );
    case "sensors": {
      const zones = card.zones.map((z) => ({ ...z, label: zoneLabel(z.zone) }));
      const items = zones.map((z) => ({
        text: `${z.label} · ${z.distance.status === "measured" ? centimetres(z.distance.mm) : NOT_MEASURED}`,
        sizeAs: `${z.label} · ${NOT_MEASURED}`,
        size: "body" as const,
        simulated: z.simulated,
        unknown: z.distance.status === "unknown",
      }));
      // The nearest measured zone, the first of equals. Unknown is never taken as far away, or as clear.
      const nearest = zones.reduce<(typeof zones)[number] | null>(
        (best, z) => (z.distance.status === "measured" && (best?.distance.status !== "measured" || z.distance.mm < best.distance.mm) ? z : best),
        null,
      );
      const widest = zones.reduce((a, z) => (chars(z.label) > chars(a) ? z.label : a), "");
      const simulated = zones.filter((z) => z.simulated);
      return cardScene(
        zones.map((z) => `${z.zone}${z.simulated ? "*" : ""}`).join(","),
        {
          main: nearest?.distance.status === "measured" ? `${nearest.label} · ${centimetres(nearest.distance.mm)}` : NOT_MEASURED,
          mainAs: [`${widest} · ${WIDEST_DISTANCE}`, NOT_MEASURED].reduce((a, b) => (chars(b) > chars(a) ? b : a)),
          mainSizes: ["main", "message", "title", "small"],
          layouts: listLayouts(items),
          prefer: "layout",
        },
        `Sensor readings on screen, updated as they come: ${listWords(zones.map((z) => spokenZone(z.zone)))}.` +
          (simulated.length === zones.length ? " Simulated." : simulated.length ? ` Simulated: ${listWords(simulated.map((z) => spokenZone(z.zone)))}.` : ""),
      );
    }
    case "message":
      // As the message screen, without its Confirm hint: the Pi doesn't replay a message from this card.
      return {
        key: `showing:message:${card.message_id}`,
        main: { text: card.text, size: "message" },
        lines: [detail(`From ${card.from_name}`), ...caption],
        announce: `${card.from_name} says: ${card.text}`,
      };
    case "parts": {
      const parts = [...card.parts]
        .sort((a, b) => partOrder(a) - partOrder(b))
        .map((p) => ({ ...p, name: getCatalogEntry(MODULE_CATALOG, p.module_id).name, word: HEALTH_WORD[p.health] }));
      // A simulated part is a stand-in: never called working. Its other health words still show.
      const standIn = (p: (typeof parts)[number]) => p.simulated && p.health === "ok";
      const items = parts.map((p): CardLine => ({ text: standIn(p) ? p.name : `${p.name} · ${p.word}`, size: "body", simulated: p.simulated }));
      const spoken = parts.map((p) => (standIn(p) ? `${p.name}, simulated` : `${p.name}, ${p.word.toLowerCase()}${p.simulated ? ", simulated" : ""}`));
      const count = `${parts.length} ${parts.length === 1 ? "part" : "parts"}`;
      return cardScene(
        parts.map((p) => `${p.module_id}:${p.health}${p.simulated ? "*" : ""}`).join(","),
        { main: count, mainSizes: ["main", "message", "title", "small"], layouts: listLayouts(items), prefer: "layout" },
        `${count}: ${spoken.join("; ")}.`,
      );
    }
  }
}

function myScreen(view: Extract<ScreenContent, { state: "my_screen" }>["view"], settings: ScreenSettings): Scene {
  switch (view.page) {
    case "menu":
      return {
        key: "my_screen:menu",
        main: { text: "My screen", size: "main" },
        lines: [detail("Goes back to the clock by itself.")],
        center: { buttons: [button("text_size", "Text size"), button("reading", "Reading"), button("circle", "Your circle")] },
      };
    case "text_size":
      return {
        key: "my_screen:text_size",
        main: { text: `${TEXT_SIZE_WORD[settings.text_size]} text`, size: "main" },
        lines: [detail("Changes at once, on this walker.")],
        center: {
          buttons: [
            button("text_smaller", "Smaller", { disabled: settings.text_size === "large" }),
            button("text_bigger", "Bigger", { disabled: settings.text_size === "largest" }),
            button("done", "Done"),
          ],
        },
      };
    case "reading":
      return {
        key: "my_screen:reading",
        main: { text: "Reading", size: "main" },
        lines: [
          body(`Captions: ${settings.captions ? "on" : "off"}`),
          detail(`Read messages aloud automatically: ${settings.read_messages_aloud ? "on" : "off"}`),
        ],
        center: {
          buttons: [
            button("toggle_captions", "Captions", { pressed: settings.captions }),
            button("toggle_read_aloud", "Read aloud", { pressed: settings.read_messages_aloud }),
            button("done", "Done"),
          ],
        },
      };
    case "circle": {
      const owner = view.owner_name ?? "Your family";
      if (view.member === null) {
        return {
          key: "my_screen:circle:0",
          main: { text: view.owner_name ?? "Who set it up", size: "main" },
          lines: [detail("Set up your walker."), detail(`${owner} can read your conversations on the Sophi website.`)],
          center: { buttons: [button("next", "Next", { disabled: view.count === 1 }), button("done", "Done")] },
        };
      }
      const role = view.member.role === "family" ? "Family" : "Caregiver";
      if (view.confirm_remove) {
        return {
          key: `my_screen:circle:${view.member.member_id}:remove`,
          main: { text: "Remove?", size: "main" },
          lines: [body(view.member.name), detail("Their messages are deleted too.")],
          center: { buttons: [button("keep", "Keep"), button("remove", "Remove")] },
        };
      }
      return {
        key: `my_screen:circle:${view.member.member_id}`,
        main: { text: view.member.name, size: "main" },
        lines: [body(role), detail(`${view.index + 1} of ${view.count} in your circle`)],
        center: { buttons: [button("remove", "Remove"), button("next", "Next", { disabled: view.index + 1 >= view.count }), button("done", "Done")] },
      };
    }
  }
}

/**
 * The view for a state. `settings` replaces the state's own (the web app's Preview draws a draft this way);
 * by default the screen draws the settings the Pi sent.
 */
export function screenView(state: ScreenState, settings: ScreenSettings = state.settings): ScreenView {
  const s = scene(state.screen, settings, state);
  const clock = state.strip.clock ? clockWords(state.strip.clock.local_time) : null;
  const left = s.left ?? null;
  const center = { lines: s.center?.lines ?? [], buttons: s.center?.buttons ?? [] };
  const hold = s.hold ?? null;
  const buttons = (left?.kind === "button" ? 1 : 0) + center.buttons.length + (hold ? 1 : 0);
  if (buttons > MAX_BUTTONS) throw new Error(`A screen has at most ${MAX_BUTTONS} buttons.`);
  const lines = s.lines ?? [];
  const strip = state.strip;
  return {
    theme: settings.theme,
    textSize: settings.text_size,
    sizes: screenSizes(settings.text_size),
    sceneKey: s.key,
    itemId: s.itemId ?? null,
    revision: state.revision,
    settingsVersion: settings.version,
    strip: {
      ...presence(strip.link),
      // The clock screen's main line is the time, so the strip doesn't repeat it there.
      time: state.screen.state === "ambient" ? null : (clock?.time ?? null),
      simulator: strip.simulator,
      // The strip has room for one tag beside "Connecting" and the time. On the simulator, "Simulator" already
      // says nothing real moves; the motion screens still say BENCH_MODE_LABEL in full.
      bench: strip.bench_mode && !strip.simulator,
    },
    main: s.main,
    lines,
    left,
    center,
    hold,
    right: s.right ?? "Talk",
    announce: s.announce ?? [s.main.text, ...lines.map((l) => l.text), ...center.lines.map((l) => l.text)].join(". "),
    nav: s.nav ?? null,
  };
}
