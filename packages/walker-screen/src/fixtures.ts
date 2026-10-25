import {
  DEFAULT_SCREEN_CHOICES,
  FAULT_SENTENCES,
  REFUSAL_SENTENCES,
  TEXT_SIZES,
  confirmPrompt,
  type MotionFaultCode,
  type LatLon,
  type MotionRefusal,
  type NavigatingScreen,
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

/**
 * A walking route by Lake Merritt, Oakland: OpenStreetMap's foot router (routing.openstreetmap.de) from the
 * simulator's starting point to the Lake Merritt Boating Center, fetched once on 2026-10-24 and rounded to 6
 * places. Illustrative data for drawing, not a recorded walk: map data © OpenStreetMap contributors.
 */
export const DEMO_ROUTE: readonly LatLon[] = [
  [37.809811, -122.257641], [37.809945, -122.25809], [37.809971, -122.258176], [37.809958, -122.258182], [37.809851, -122.258235],
  [37.809485, -122.258412], [37.80946, -122.258426], [37.80943, -122.258342], [37.809314, -122.258407], [37.809209, -122.258465],
  [37.809193, -122.258474], [37.809139, -122.258333], [37.809083, -122.258339], [37.809025, -122.258344], [37.808969, -122.258339],
  [37.808918, -122.258329], [37.808851, -122.258311], [37.80877, -122.258284], [37.808679, -122.258237], [37.808601, -122.258179],
  [37.808364, -122.257952], [37.808352, -122.257939], [37.808285, -122.257973], [37.808089, -122.258074], [37.807946, -122.258143],
  [37.807597, -122.258332], [37.807481, -122.258334], [37.807462, -122.258295], [37.807366, -122.258094], [37.807303, -122.257992],
  [37.807203, -122.257828], [37.807125, -122.257572], [37.80706, -122.257348], [37.807045, -122.257304], [37.807023, -122.257239],
  [37.806943, -122.257039], [37.806895, -122.256946], [37.806854, -122.256879], [37.806817, -122.256836], [37.806757, -122.256786],
  [37.806748, -122.256792], [37.806722, -122.25671], [37.806699, -122.256639], [37.806686, -122.256596], [37.806655, -122.256619],
  [37.80664, -122.25663], [37.806628, -122.256641], [37.806563, -122.256696], [37.806453, -122.256755], [37.806337, -122.256817],
  [37.80628, -122.256821], [37.806159, -122.256842], [37.806048, -122.256822], [37.805987, -122.256794], [37.805926, -122.256865],
  [37.805908, -122.256896], [37.805889, -122.256952], [37.805836, -122.256966], [37.805801, -122.256976], [37.805762, -122.256992],
  [37.805723, -122.257011], [37.805679, -122.257042], [37.805634, -122.25708], [37.805597, -122.257119], [37.805548, -122.257184],
  [37.805525, -122.257226], [37.805513, -122.257238], [37.805497, -122.257249], [37.805468, -122.257264], [37.805436, -122.257272],
  [37.805379, -122.257289], [37.805355, -122.257262], [37.805299, -122.257364], [37.80522, -122.257582], [37.805086, -122.257848],
];
/** The longest street (60 characters) and place name (100) the contract allows, in real words. */
export const LONGEST_STREET = "Martin Luther King Junior Way by the Lake Merritt Shore Path";
export const LONGEST_PLACE = "Lake Merritt Boating Center and Lakeside Park Garden Center, 66 Bellevue Avenue, Oakland, California";
const LONGEST_INSTRUCTION = "Turn around, then turn right onto Martin Luther King Junior Way by the Lake Merritt Shore Path.";

type NavOverrides = Partial<Omit<NavigatingScreen, "state" | "map">> & { position?: LatLon | null };

/**
 * A navigating state on the demo route: the route ahead from route point `from`, the next step at point `step`,
 * and her position where the route ahead starts (20 m along, 30 m before the turn onto Lenox Avenue, by
 * default) unless `position` says otherwise.
 */
function nav(over: NavOverrides, from = 1, step: number | null = 2): NavigatingScreen {
  const { position = from === 1 ? ([37.809875, -122.257855] as LatLon) : DEMO_ROUTE[from]!, ...rest } = over;
  return {
    state: "navigating",
    destination: "Lake Merritt Boating Center",
    phase: "guiding",
    instruction: "Turn left onto Lenox Avenue.",
    maneuver: "left",
    street: "Lenox Avenue",
    to_step_m: 30,
    remaining_m: 750,
    remaining_min: 10,
    simulated: true,
    ...rest,
    map: {
      position,
      route: [...(position && from === 1 ? [position] : []), ...DEMO_ROUTE.slice(from)],
      step_at: step === null ? null : DEMO_ROUTE[step]!,
      destination_at: DEMO_ROUTE[DEMO_ROUTE.length - 1]!,
    },
  };
}

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
  // Walking directions (added 2026-10-24): every phase, the demo's route, and the longest street (60
  // characters) and place name (100) the contract allows.
  { name: "navigating", screen: nav({}), strip: { simulator: true } },
  { name: "navigating-dark", screen: nav({}), choices: { theme: "dark" }, strip: { simulator: true } },
  {
    name: "navigating-real-gps-path",
    screen: nav({ instruction: "Turn left onto the path.", maneuver: "left", street: null, to_step_m: 50, remaining_m: 710, remaining_min: 10, simulated: false }, 4, 6),
  },
  {
    name: "navigating-offline-slight-right",
    screen: nav({ instruction: "Bear slightly right onto Bellevue Avenue.", maneuver: "slight_right", street: "Bellevue Avenue", to_step_m: 0, remaining_m: 360, remaining_min: 5, simulated: false }, 30, 30),
    strip: { link: "offline" },
  },
  {
    name: "navigating-longest",
    screen: nav(
      { destination: LONGEST_PLACE, instruction: LONGEST_INSTRUCTION, maneuver: "u_turn", street: LONGEST_STREET, to_step_m: 1250, remaining_m: 4950, remaining_min: 69 },
      20,
      26,
    ),
    strip: { link: "connecting", simulator: true, ...BENCH },
  },
  {
    name: "navigating-arrive-next-longest",
    screen: nav({ destination: LONGEST_PLACE, instruction: "Arrive at the Lake Merritt Boating Center.", maneuver: "arrive", street: null, to_step_m: 30, remaining_m: 30, remaining_min: 0 }, 72, null),
  },
  // Every other maneuver word, so each is drawn and measured at every size (illustrative streets).
  { name: "navigating-ahead", screen: nav({ instruction: "Continue onto Grand Avenue.", maneuver: "straight", street: "Grand Avenue", to_step_m: 120 }) },
  { name: "navigating-right", screen: nav({ instruction: "Turn right onto Bellevue Avenue.", maneuver: "right", street: "Bellevue Avenue" }) },
  { name: "navigating-slight-left", screen: nav({ instruction: "Bear slightly left onto the path.", maneuver: "slight_left", street: null }) },
  { name: "navigating-sharp-left", screen: nav({ instruction: "Turn sharp left onto Perkins Street.", maneuver: "sharp_left", street: "Perkins Street" }) },
  { name: "navigating-sharp-right", screen: nav({ instruction: "Turn sharp right onto Lakeshore Avenue.", maneuver: "sharp_right", street: "Lakeshore Avenue" }) },
  { name: "navigating-rerouting", screen: nav({ phase: "rerouting", position: [37.80835, -122.25745] }, 20, 26), strip: { simulator: true } },
  { name: "navigating-off-route-longest", screen: nav({ phase: "off_route", destination: LONGEST_PLACE, position: [37.80835, -122.25745] }, 20, 26), strip: { simulator: true } },
  { name: "navigating-no-position", screen: nav({ phase: "no_position", to_step_m: null, position: null, simulated: false }, 13, 20) },
  {
    name: "navigating-arrived",
    screen: nav({ phase: "arrived", instruction: "Arrive at the Lake Merritt Boating Center.", maneuver: "arrive", street: null, to_step_m: 0, remaining_m: 0, remaining_min: 0, position: [37.80511, -122.25779] }, 73, null),
    strip: { simulator: true },
  },
  {
    name: "navigating-arrived-longest",
    screen: nav(
      { phase: "arrived", destination: LONGEST_PLACE, instruction: "Arrive at the Lake Merritt Boating Center.", maneuver: "arrive", street: null, to_step_m: 0, remaining_m: 0, remaining_min: 0, position: [37.80511, -122.25779] },
      73,
      null,
    ),
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
