import {
  BENCH_MODE_LABEL,
  FAULT_CLEAR_SENTENCE,
  FAULT_SENTENCES,
  REFUSAL_SENTENCES,
  VOICE_CHOICES,
  holdControlShown,
  type Cue,
  type ScreenAction,
  type ScreenContent,
  type ScreenHoldDirection,
  type ScreenSettings,
  type ScreenState,
  type SuggestionChange,
  type TextSize,
} from "@walker/contracts";
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
  /** `body` grows with her text size; `detail` is the smallest size; `message` is a member's message. */
  size: "body" | "detail" | "message";
  /** A dashed "Simulated" tag after the text. */
  simulated?: boolean;
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
   * size (`title`) or the smallest size (`small`).
   */
  main: { text: string; size: "main" | "body" | "message" | "title" | "small" };
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
  const budget = CAPTION_PAGE_CHARS[textSize];
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
      const distance = content.distance.status === "measured" ? `${Math.round(content.distance.mm / 10)} cm` : "Unknown";
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
      // The same names as the /walker page (apps/web/src/lib/walkerView.ts). The walker's model is Gemini.
      const source = content.source === "model" ? "Answered by Gemini" : content.source === "fixed" ? "Answered by the fixed replies" : "On the walker, offline reply";
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
    case "showing":
      // TODO(show-on-screen screen piece): the real card layouts. Until then the Pi never sends this state.
      return { key: `showing:${content.card.view}`, main: { text: content.card.view, size: "main" }, lines: [] };
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
  }
}

// ---- Motion (the arms and the lift) ----

const HOLD_WORD: Record<ScreenHoldDirection, string> = { raise: "Hold to raise", lower: "Hold to lower", home: "Hold to home", move: "Hold to move" };

/**
 * Height left for the one thing (px), from the fixed regions at 800x480: 12 px of padding, the 50 px strip,
 * two 8 px gaps, and the band over the handles (a 147 px button row, or the 48 px handle words).
 */
const ONE_THING_PX = { buttons: 480 - 12 - 50 - 16 - 147, words: 480 - 12 - 50 - 16 - 48 } as const;
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
  };
}
