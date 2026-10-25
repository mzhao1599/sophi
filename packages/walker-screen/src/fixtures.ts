import {
  DEFAULT_SCREEN_CHOICES,
  FAULT_SENTENCES,
  REFUSAL_SENTENCES,
  TEXT_SIZES,
  confirmPrompt,
  type MotionFaultCode,
  type MotionRefusal,
  type ScreenChoices,
  type ScreenContent,
  type ScreenState,
  type StatusStrip,
  type TextSize,
} from "@walker/contracts";

/**
 * Example states for every screen in the design, at every text size: for tests, screenshots and the web
 * app's Preview. Illustrative data, not a recording of a walker. Names come in two lengths: the demo's
 * (Nan, Max, Cooper) and the longest the contract allows (12 characters), so the screenshots prove the
 * worst case fits.
 */
export interface ScreenFixture {
  /** `<state>--<text size>`, also the screenshot's file name. */
  name: string;
  textSize: TextSize;
  state: ScreenState;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LONG = "Christabelle";
const LONG_OWNER = "Maximilianus";
const LONG_MEMBER = { member_id: uuid(2), name: LONG, role: "caregiver", joined_at: "2026-10-24T18:00:00.000Z" } as const;

/** A reply of about two caption pages at Large. */
export const SAMPLE_REPLY =
  "Something is about 30 centimetres ahead on your left. I can't tell what it is. Go slowly, and press Talk if you want me to check again in a moment.";

interface Base {
  name: string;
  screen: ScreenContent;
  choices?: Partial<ScreenChoices>;
  strip?: Partial<StatusStrip>;
}

const HEARD = "Is there anything in front of me right now?";

/** The longest title a Confirm target or a running motion may have (60 characters), in real words. */
export const LONGEST_MOTION_TITLE = "Bring the cup from the kitchen tray over to the left handle?";
const target = (n: number, title: string, park = true) => ({ target_id: uuid(n), title, prompt: confirmPrompt(title, park) });
const longest = <K extends string>(sentences: Readonly<Record<K, string>>): K =>
  (Object.keys(sentences) as K[]).reduce((a, b) => ([...sentences[b]].length > [...sentences[a]].length ? b : a));
/** The fault and the refusal with the longest sentences, so the screenshots prove the worst case fits. */
export const LONGEST_FAULT: MotionFaultCode = longest(FAULT_SENTENCES);
export const LONGEST_REFUSAL: MotionRefusal = longest(REFUSAL_SENTENCES);
const BENCH = { bench_mode: true } as const;

const BASES: Base[] = [
  // The walker's own states first.
  { name: "ambient", screen: { state: "ambient", alerts: ["vibration", "spoken"] }, choices: { greeting_name: "Nan" } },
  { name: "ambient-long-greeting", screen: { state: "ambient", alerts: ["vibration", "sound", "spoken"] }, choices: { greeting_name: LONG } },
  { name: "ambient-no-clock", screen: { state: "ambient", alerts: null }, choices: { greeting_name: "Nan" }, strip: { clock: null } },
  { name: "ambient-dark-simulator", screen: { state: "ambient", alerts: ["vibration", "spoken"] }, choices: { greeting_name: "Nan", theme: "dark" }, strip: { simulator: true } },
  { name: "listening", screen: { state: "listening" } },
  { name: "thinking", screen: { state: "thinking" } },
  { name: "answering", screen: { state: "answering", heard: HEARD, reply: SAMPLE_REPLY, source: "model", page: 0 } },
  { name: "answering-page-2", screen: { state: "answering", heard: HEARD, reply: SAMPLE_REPLY, source: "model", page: 1 } },
  { name: "answering-offline-reply", screen: { state: "answering", heard: null, reply: "I can't reach the internet right now. Alerts still work on the walker.", source: "walker", page: 0 }, strip: { link: "offline" } },
  { name: "answering-no-captions", screen: { state: "answering", heard: "What time is it?", reply: "It's about a quarter to eight.", source: "model", page: 0 }, choices: { captions: false } },
  { name: "model-offer", screen: { state: "model_offer", proposal_id: uuid(50), from_cues: ["vibration", "spoken"], cues: ["sound", "spoken"] } },
  { name: "obstacle-simulated", screen: { state: "obstacle", zone: "front_left", distance: { status: "measured", mm: 300 }, simulated: true }, strip: { simulator: true } },
  { name: "obstacle-unknown", screen: { state: "obstacle", zone: "front_right", distance: { status: "unknown" }, simulated: false } },
  {
    // Illustrative points by Lake Merritt, Oakland, not a recorded walk.
    name: "navigating",
    screen: {
      state: "navigating",
      destination: "Lake Merritt Boating Center",
      phase: "guiding",
      instruction: "Turn left onto Lenox Avenue.",
      maneuver: "left",
      street: "Lenox Avenue",
      to_step_m: 30,
      remaining_m: 740,
      remaining_min: 10,
      simulated: true,
      map: {
        position: [37.8094, -122.2575],
        route: [[37.8094, -122.2575], [37.8091, -122.2575], [37.8089, -122.2582], [37.8051, -122.2579]],
        step_at: [37.8091, -122.2575],
        destination_at: [37.8051, -122.2579],
      },
    },
  },
  { name: "offline", screen: { state: "offline" }, strip: { link: "offline" } },
  { name: "not-set-up", screen: { state: "not_set_up" }, strip: { link: "unpaired", clock: null } },
  { name: "done-alerts", screen: { state: "done", result: { kind: "alerts", cues: ["vibration", "sound", "spoken"] }, change_back: false } },
  { name: "done-change-back", screen: { state: "done", result: { kind: "change", change: { kind: "text_size", text_size: "larger" } }, change_back: true } },
  { name: "done-nothing-changed", screen: { state: "done", result: { kind: "nothing_changed" }, change_back: false } },
  // Her circle (secondary): kept minimal.
  { name: "suggestion-text-size", screen: { state: "suggestion", item_id: uuid(10), from_name: "Cooper", change: { kind: "text_size", text_size: "largest" }, minutes_left: 5, one_moment: false } },
  { name: "suggestion-text-size-dark", screen: { state: "suggestion", item_id: uuid(10), from_name: "Cooper", change: { kind: "text_size", text_size: "largest" }, minutes_left: 5, one_moment: false }, choices: { theme: "dark" } },
  { name: "suggestion-greeting-long", screen: { state: "suggestion", item_id: uuid(12), from_name: LONG, change: { kind: "greeting", greeting_name: LONG }, minutes_left: 4, one_moment: false } },
  { name: "suggestion-voice-one-moment", screen: { state: "suggestion", item_id: uuid(13), from_name: "Cooper", change: { kind: "voice", voice: "calm" }, minutes_left: 5, one_moment: true } },
  { name: "join", screen: { state: "member_join", item_id: uuid(14), name: "Cooper", role: "family", invited_by_name: "Max", step: "first", minutes_left: 5, one_moment: false } },
  { name: "join-long", screen: { state: "member_join", item_id: uuid(15), name: LONG, role: "caregiver", invited_by_name: LONG_OWNER, step: "first", minutes_left: 5, one_moment: false } },
  { name: "join-again-long", screen: { state: "member_join", item_id: uuid(15), name: LONG, role: "caregiver", invited_by_name: LONG_OWNER, step: "again", minutes_left: 5, one_moment: true } },
  { name: "message-waiting", screen: { state: "message_waiting", message_id: uuid(20), from_name: "Cooper", more: 0 } },
  /** The longest message (30 characters, wide letters) from the longest name. */
  { name: "message-longest", screen: { state: "message", message_id: uuid(21), from_name: LONG, text: "Mmm, wonderful dinner with Mom" } },
  { name: "my-screen", screen: { state: "my_screen", view: { page: "menu" } } },
  { name: "my-screen-text-size", screen: { state: "my_screen", view: { page: "text_size" } } },
  { name: "my-screen-reading", screen: { state: "my_screen", view: { page: "reading" } } },
  { name: "my-screen-circle-member", screen: { state: "my_screen", view: { page: "circle", index: 2, owner_name: "Max", member: LONG_MEMBER, count: 3, confirm_remove: false } } },
  { name: "my-screen-circle-remove", screen: { state: "my_screen", view: { page: "circle", index: 2, owner_name: "Max", member: LONG_MEMBER, count: 3, confirm_remove: true } } },
  // Motion (the arms and the lift), added 2026-10-24. The demo walker runs in bench mode until a stop is wired.
  { name: "ambient-bench", screen: { state: "ambient", alerts: ["vibration", "spoken"] }, choices: { greeting_name: "Nan" }, strip: BENCH },
  { name: "ambient-connecting-simulator-bench", screen: { state: "ambient", alerts: ["vibration", "spoken"] }, strip: { link: "connecting", simulator: true, ...BENCH } },
  { name: "listening-bench", screen: { state: "listening" }, strip: BENCH },
  { name: "motion-confirm-cup", screen: { state: "motion_confirm", target: target(60, "Bring the cup?"), hold: null } },
  { name: "motion-confirm-cup-bench", screen: { state: "motion_confirm", target: target(60, "Bring the cup?"), hold: null }, strip: BENCH },
  { name: "motion-confirm-let-go", screen: { state: "motion_confirm", target: target(61, "Let go?"), hold: null }, strip: BENCH },
  { name: "motion-confirm-lift-raise", screen: { state: "motion_confirm", target: target(62, "Raise the lift?"), hold: "raise" }, strip: BENCH },
  { name: "motion-confirm-lift-home-no-bench", screen: { state: "motion_confirm", target: target(63, "Home the lift?"), hold: "home" } },
  {
    name: "motion-confirm-longest-hold",
    screen: { state: "motion_confirm", target: target(64, LONGEST_MOTION_TITLE), hold: "lower" },
    strip: { link: "connecting", simulator: true, ...BENCH },
  },
  { name: "motion-confirm-longest", screen: { state: "motion_confirm", target: target(65, LONGEST_MOTION_TITLE), hold: null }, strip: BENCH },
  { name: "motion-running-cup", screen: { state: "motion_running", what: "Bring the cup", lift: null }, strip: BENCH },
  { name: "motion-running-lift", screen: { state: "motion_running", what: "Raising the lift", lift: { phase: "running", direction: "raise" } }, strip: BENCH },
  { name: "motion-running-lift-stopping", screen: { state: "motion_running", what: "Raising the lift", lift: { phase: "stopping", direction: "raise" } }, strip: BENCH },
  {
    name: "motion-running-longest-lift",
    screen: { state: "motion_running", what: LONGEST_MOTION_TITLE.replace("?", ""), lift: { phase: "running", direction: "move" } },
    strip: { link: "connecting", simulator: true, ...BENCH },
  },
  { name: "motion-running-longest", screen: { state: "motion_running", what: LONGEST_MOTION_TITLE.replace("?", ""), lift: null }, strip: BENCH },
  { name: "motion-holding-stopped", screen: { state: "motion_holding", outcome: "stopped", refusal: null }, strip: BENCH },
  { name: "motion-holding-done", screen: { state: "motion_holding", outcome: "completed", refusal: null } },
  { name: "motion-holding-not-held", screen: { state: "motion_holding", outcome: "not_started", refusal: "not_held" }, strip: BENCH },
  { name: "motion-holding-longest-refusal", screen: { state: "motion_holding", outcome: "not_started", refusal: LONGEST_REFUSAL }, strip: BENCH },
  { name: "motion-fault-stop-switch", screen: { state: "motion_fault", faults: ["stop_circuit_opened", "lift_unhomed"], confirm: null } },
  {
    name: "motion-fault-longest",
    screen: { state: "motion_fault", faults: [LONGEST_FAULT, "limit_wiring", "lift_unhomed"], confirm: null },
    strip: { link: "connecting", simulator: true, ...BENCH },
  },
  {
    name: "motion-fault-clear",
    screen: { state: "motion_fault", faults: ["overload"], confirm: { ...target(66, "Clear it?", false) } },
    strip: BENCH,
  },
  {
    name: "motion-fault-clear-longest",
    screen: { state: "motion_fault", faults: [LONGEST_FAULT, "overload"], confirm: target(67, LONGEST_MOTION_TITLE, false) },
    strip: BENCH,
  },
];

export function screenFixtures(): ScreenFixture[] {
  return TEXT_SIZES.flatMap((textSize) =>
    BASES.map((base, i) => ({
      name: `${base.name}--${textSize}`,
      textSize,
      state: {
        v: 1,
        revision: i,
        screen: base.screen,
        settings: {
          version: 3,
          ...DEFAULT_SCREEN_CHOICES,
          ...base.choices,
          text_size: textSize,
          changed_at: "2026-10-24T18:30:00.000Z",
          pending_local: false,
        },
        strip: { link: "online", simulator: false, bench_mode: false, clock: { local_time: "2026-10-24T19:42:00" }, ...base.strip },
      },
    })),
  );
}

/** Every state name the fixtures cover (each must appear). */
export const FIXTURE_STATE_NAMES = [...new Set(BASES.map((b) => b.screen.state))];
