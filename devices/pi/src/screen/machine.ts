import type { AppliedScreenSettings, Cue, MotionState, NavigatingScreen, ScreenContent, ScreenHoldDirection, ScreenLink, ScreenState } from "@walker/contracts";
import { captionPages } from "@walker/walker-screen/view";
import type { HelpScreen, TalkState } from "../bus";
import type { Cancel, Clock } from "../clock";
import {
  CAPTION_CHARS_PER_S,
  CAPTION_PAGE_MIN_MS,
  NEAR_ENTER_MM,
  NEAR_EXIT_MM,
  SCREEN_ANSWER_HOLD_MS,
  SCREEN_DONE_MS,
  SCREEN_MESSAGE_HOLD_MS,
  SCREEN_MOTION_STALE_MS,
  SCREEN_OBSTACLE_TAIL_MS,
  SCREEN_ZONES_MIN_MS,
  ZONE_VALIDITY_MS,
} from "../constants";
import { endedBetween, liftDirection, motionContent, type MotionHolding, type ScreenMotion } from "./motion";

/**
 * Which state the walker's screen shows, decided on the Pi (the page decides nothing). Only the walker's own
 * states, and a caretaker's message as it is read aloud; the circle's other states (suggestions, joins, the
 * "message waiting" notice, My screen) come with the circle feed.
 *
 * Priority, highest first (the screen design, section 2, and the contract's ScreenContent comment):
 *   1. obstacle: a zone is near (the cue policy's thresholds and hysteresis), and for a short tail after
 *   2. motion she must know about now: something moving (and that any handle button stops it, or that letting
 *      go of the lift stops it), or a latched motion fault (with its clearing target, if one is pending)
 *   3. what she is doing: listening (Talk held), thinking (her turn is with Sophi), then answering (captions)
 *   3b. asking for help (src/help.ts): her hold, the countdown, or the request (sending, not sent, open, closed).
 *      Under her Talk, so a turn shows and then help comes back; above everything below (the contract's order)
 *   4. the pending motion Confirm target ("Bring the cup? Park the walker…"), with the lift's hold control
 *   5. Sophi's offer: today's model offer, until it is settled or closes
 *   6. Done / Nothing changed, for a few seconds after Confirm settles an offer; and after a motion, Done,
 *      Stopped or Not started (the motion's own "holding" screen)
 *   7. a caretaker's message: its words while the walker reads it aloud, and for SCREEN_MESSAGE_HOLD_MS after
 *      (shown offline too, when Confirm reads it again)
 *   8. walking directions: the Navigator's latest view while a route is on (`navigation` on the bus), offline
 *      too, since guidance runs on the Pi; everything above still comes first, and the route returns after
 *   9. offline, or not set up (unpaired, or the server no longer knows this walker)
 *  10. ambient: the clock, and the alerts in force
 * Why motion sits where it does: an obstacle is the walker's first job, about her body in the next second.
 * A running motion or a fault is next because it is about motors moving near her now: the screen must keep
 * saying what moves and how to stop it, above anything of hers still on screen (any handle press stops it,
 * and her own screens come back underneath once it has). Her own Talk turn comes before a pending target: a
 * target only waits (30 s) and nothing moves until a handle Confirm press, while her question is happening
 * now; and a Talk press withdraws a pending target (the coordinator's rule), so her turn doesn't hide one a
 * Confirm press could answer. (A target the terminal prepares during her turn is said aloud at once but shown
 * only once her turn is over; a Confirm press in between still answers it.) The target comes before Sophi's
 * offer and Done, which the coordinator never shows together
 * with it (one owner of Confirm at a time).
 * The state is recomputed from these layers whenever one changes, so an interruption (an obstacle, Talk)
 * returns to whatever is still underneath it, with a new revision.
 *
 * While a turn is in flight (Talk released, no answer yet) the screen says "One moment" (`thinking`), so it
 * goes Listening, One moment, then the captions, never back to the clock in between.
 */

/** While the clock has never synced (no time shown), how often to look again. */
export const CLOCK_RECHECK_MS = 30_000;

export type SettleResult = { kind: "alerts"; cues: Cue[] } | { kind: "nothing_changed" };

export interface ScreenZone {
  zone: string;
  mm: number | null;
  quality: "valid" | "invalid";
  /** The reading came from a simulated sensor. */
  simulated: boolean;
}

export interface ScreenAnswer {
  id: number;
  heard: string | null;
  reply: string;
  source: "model" | "fixed" | "walker";
  startedMono: number;
  /** When it finished playing; null while it plays. */
  spokenMono: number | null;
}

export interface ScreenObstacle {
  zone: string;
  /** The last near distance in mm, or null when that zone's reading is now invalid or missing. */
  mm: number | null;
  simulated: boolean;
  lastNearMono: number;
  /** A zone is near right now (not just the tail). */
  near: boolean;
}

export interface ScreenMessage {
  id: number;
  message_id: string;
  from_name: string;
  text: string;
  /** When it finished playing; null while it plays. */
  spokenMono: number | null;
}

/** Everything the choice depends on: the inputs of the pure function below. */
export interface ScreenModel {
  link: ScreenLink;
  talk: TalkState;
  alerts: Cue[] | null;
  offer: { proposal_id: string; from_cues: Cue[]; cues: Cue[] } | null;
  answer: ScreenAnswer | null;
  done: { result: SettleResult; untilMono: number } | null;
  obstacle: ScreenObstacle | null;
  /** The motion coordinator's latest state, or null when there is none (no arms or lift on this walker). */
  motion: ScreenMotion | null;
  /** Done, Stopped or Not started after a motion, until `untilMono`. */
  motionEnded: { content: MotionHolding; untilMono: number } | null;
  /** The caretaker's message being read aloud, or read last. */
  message: ScreenMessage | null;
  /** The route in progress as the Navigator draws it (validated against the contract), or null with no route. */
  navigation: NavigatingScreen | null;
  /** What the help layer shows (src/help.ts decides it), or null. */
  help: HelpScreen | null;
}

/** How long one caption page shows: its characters at the speaking rate, and never less than the minimum. */
export function pageMs(text: string): number {
  return Math.max(CAPTION_PAGE_MIN_MS, Math.round(([...text].length * 1000) / CAPTION_CHARS_PER_S));
}

/** The caption page showing `elapsed` ms into an answer, and when the next one starts (null on the last). */
export function pageAt(pages: readonly string[], elapsed: number): { page: number; nextInMs: number | null } {
  let start = 0;
  for (let i = 0; i < pages.length - 1; i += 1) {
    const end = start + pageMs(pages[i]!);
    if (elapsed < end) return { page: i, nextInMs: end - elapsed };
    start = end;
  }
  return { page: pages.length - 1, nextInMs: null };
}

/** When an answer stops showing: once it has played and every page has had its time, plus a hold (none with an offer). */
export function answerEndsAt(answer: ScreenAnswer, pages: readonly string[], captions: boolean, offerOpen: boolean): number | null {
  if (answer.spokenMono === null) return null;
  const paged = captions ? answer.startedMono + pages.reduce((sum, p) => sum + pageMs(p), 0) : answer.startedMono;
  return Math.max(answer.spokenMono, paged) + (offerOpen ? 0 : SCREEN_ANSWER_HOLD_MS);
}

/**
 * The pure choice: the one thing on screen at `now` (monotonic ms), and when that could next change on its
 * own (a caption page turning, Done or the obstacle tail ending), or null when only an input can change it.
 */
export function pickScreen(model: ScreenModel, now: number, settings: Pick<AppliedScreenSettings, "text_size" | "captions">): { content: ScreenContent; nextAt: number | null } {
  const soonest: number[] = [];
  let content: ScreenContent | null = null;

  const obstacle = model.obstacle;
  if (obstacle && (obstacle.near || now < obstacle.lastNearMono + SCREEN_OBSTACLE_TAIL_MS)) {
    if (!obstacle.near) soonest.push(obstacle.lastNearMono + SCREEN_OBSTACLE_TAIL_MS);
    content = {
      state: "obstacle",
      zone: obstacle.zone,
      distance: obstacle.mm === null ? { status: "unknown" } : { status: "measured", mm: obstacle.mm },
      simulated: obstacle.simulated,
    };
  }

  // Layers under the obstacle still keep their own clocks, so the soonest change is collected for each.
  // Motion: a state older than SCREEN_MOTION_STALE_MS shows nothing (the coordinator stopped publishing).
  let motion: ReturnType<typeof motionContent> = { safety: null, pending: null };
  if (model.motion) {
    const staleAt = model.motion.atMono + SCREEN_MOTION_STALE_MS;
    if (now < staleAt) {
      motion = motionContent(model.motion);
      soonest.push(staleAt);
    }
  }

  let doing: ScreenContent | null = null;
  if (model.talk === "recording") doing = { state: "listening" };
  else if (model.talk === "waiting") doing = { state: "thinking" };
  else if (model.answer) {
    const pages = captionPages(model.answer.reply, settings.text_size);
    const ends = answerEndsAt(model.answer, pages, settings.captions, model.offer !== null);
    if (ends === null || now < ends) {
      const { page, nextInMs } = pageAt(pages, now - model.answer.startedMono);
      if (settings.captions && nextInMs !== null) soonest.push(now + nextInMs);
      if (ends !== null) soonest.push(ends);
      doing = { state: "answering", heard: model.answer.heard, reply: model.answer.reply, source: model.answer.source, page: settings.captions ? page : 0 };
    }
  }

  let under: ScreenContent;
  if (motion.safety) under = motion.safety;
  else if (doing) under = doing;
  else if (model.help) under = model.help;
  else if (motion.pending) under = motion.pending;
  else if (model.offer) under = { state: "model_offer", proposal_id: model.offer.proposal_id, from_cues: model.offer.from_cues, cues: model.offer.cues };
  else if (model.done && now < model.done.untilMono) {
    soonest.push(model.done.untilMono);
    under = { state: "done", result: model.done.result, change_back: false };
  } else if (model.motionEnded && now < model.motionEnded.untilMono) {
    soonest.push(model.motionEnded.untilMono);
    under = model.motionEnded.content;
  } else if (model.message && (model.message.spokenMono === null || now < model.message.spokenMono + SCREEN_MESSAGE_HOLD_MS)) {
    if (model.message.spokenMono !== null) soonest.push(model.message.spokenMono + SCREEN_MESSAGE_HOLD_MS);
    under = { state: "message", message_id: model.message.message_id, from_name: model.message.from_name, text: model.message.text };
  } else if (model.navigation) under = model.navigation;
  else if (model.link === "offline") under = { state: "offline" };
  else if (model.link === "unpaired" || model.link === "unauthorized") under = { state: "not_set_up" };
  else under = { state: "ambient", alerts: model.alerts };

  const future = soonest.filter((t) => t > now);
  return { content: content ?? under, nextAt: future.length ? Math.min(...future) : null };
}

/** The walker's local wall time, no offset, as the strip wants it: "2026-10-24T19:42:05". */
export function localWallTime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export interface ScreenMachineDeps {
  clock: Clock;
  simulator: boolean;
  settings: AppliedScreenSettings;
  /** The local wall time, or null when the walker's clock has never synced (then no time is shown). */
  localTime: () => string | null;
  /** Each new state, in revision order. Called from a timer or a microtask, never from inside an input call. */
  onState: (state: ScreenState) => void;
  /** Something inside the machine threw: logged by the caller, and the walker carries on. */
  onError: (error: Error) => void;
}

/**
 * Holds the model, turns inputs into it, and sends a new `ScreenState` (one revision higher) only when what
 * would be drawn changes. Changes made together (Talk going idle and the answer arriving) are sent as one
 * state, so the page never flashes an in-between screen. The clock is redrawn on the minute.
 */
export class ScreenMachine {
  private model: ScreenModel = {
    link: "unpaired",
    talk: "idle",
    alerts: null,
    offer: null,
    answer: null,
    done: null,
    obstacle: null,
    motion: null,
    motionEnded: null,
    message: null,
    navigation: null,
    help: null,
  };
  private revision = -1;
  private last: ScreenState | null = null;
  private lastKey = "";
  private queued = false;
  private stopped = false;
  private cancelTimer: Cancel | null = null;
  private timerAt: number | null = null;
  private readonly near = new Map<string, boolean>();
  private lastZonesSent = Number.NEGATIVE_INFINITY;
  private cancelZones: Cancel | null = null;
  private cancelStale: Cancel | null = null;
  /** While Confirm is in flight the offer stays on screen; a change to it waits here until Confirm ends. */
  private confirming = false;
  private offerAfterConfirm: ScreenModel["offer"] | undefined = undefined;

  constructor(private readonly deps: ScreenMachineDeps) {}

  /** The latest state sent (null before the first). */
  current(): ScreenState | null {
    return this.last;
  }

  /** Seeds the inputs (from the service, before the bus delivers changes) and sends the first state. */
  seed(inputs: Partial<Pick<ScreenModel, "link" | "talk" | "alerts" | "offer">>): void {
    Object.assign(this.model, inputs);
    this.changed();
  }

  link(link: ScreenLink): void {
    this.model.link = link;
    this.changed();
  }

  talk(talk: TalkState): void {
    this.model.talk = talk;
    // A new question replaces the last answer and any Done: after listening, the screen goes back underneath.
    if (talk === "recording") {
      this.model.answer = null;
      this.model.done = null;
      this.model.message = null;
    }
    this.changed();
  }

  alerts(cues: Cue[] | null): void {
    this.model.alerts = cues;
    this.changed();
  }

  answer(answer: { id: number; heard: string | null; reply: string; source: ScreenAnswer["source"] }): void {
    this.model.answer = { ...answer, startedMono: this.deps.clock.monotonic(), spokenMono: null };
    this.changed();
  }

  answerSpoken(id: number): void {
    if (this.model.answer?.id !== id || this.model.answer.spokenMono !== null) return;
    this.model.answer.spokenMono = this.deps.clock.monotonic();
    this.changed();
  }

  /**
   * The help layer. Her hold or the countdown starting drops the last answer, any Done and a message (as a Talk
   * press does), so the countdown shows from its first second; a request arriving from a poll drops nothing.
   */
  help(screen: HelpScreen | null): void {
    const gesture = (h: HelpScreen | null) => h?.state === "help_hold" || h?.state === "help_countdown";
    if (gesture(screen) && !gesture(this.model.help)) {
      this.model.answer = null;
      this.model.done = null;
      this.model.message = null;
    }
    this.model.help = screen;
    this.changed();
  }

  /** A caretaker's message, as the walker starts reading it aloud (a new one, or heard again). */
  message(message: { id: number; message_id: string; from_name: string; text: string }): void {
    this.model.message = { ...message, spokenMono: null };
    this.changed();
  }

  messageSpoken(id: number): void {
    if (this.model.message?.id !== id || this.model.message.spokenMono !== null) return;
    this.model.message.spokenMono = this.deps.clock.monotonic();
    this.changed();
  }

  /**
   * The Navigator's view of the route in progress, about once a second while she walks, or null when it ends. A
   * Talk press doesn't clear it: the route comes back once her turn is over. Each new position is a new state
   * (the map moves); the page's scene, and what a screen reader hears, change only with the instruction.
   */
  navigation(view: NavigatingScreen | null): void {
    this.model.navigation = view;
    this.changed();
  }

  offer(proposal: { proposal_id: string; from_cues: Cue[]; cues: Cue[] } | null): void {
    const next = proposal ? { proposal_id: proposal.proposal_id, from_cues: [...proposal.from_cues], cues: [...proposal.cues] } : null;
    if (this.confirming) this.offerAfterConfirm = next;
    else this.model.offer = next;
    this.changed();
  }

  /**
   * Confirm is being answered: the offer stays on screen (no clock flashing up while the change is fetched)
   * until it ends; then "Done" if it was applied, otherwise whatever is true now.
   */
  confirm(phase: "started" | "ended"): void {
    this.confirming = phase === "started";
    if (phase === "ended" && this.offerAfterConfirm !== undefined) {
      this.model.offer = this.offerAfterConfirm;
      this.offerAfterConfirm = undefined;
    }
    this.changed();
  }

  /** Confirm settled the offer: Done (or Nothing changed) shows at once, ahead of the captions still up. */
  settled(result: SettleResult): void {
    this.model.done = { result, untilMono: this.deps.clock.monotonic() + SCREEN_DONE_MS };
    this.model.answer = null;
    // The offer it settled is closed: Done shows now, not after Confirm's other bookkeeping.
    if (this.confirming) {
      this.model.offer = this.offerAfterConfirm ?? null;
      this.offerAfterConfirm = undefined;
    }
    this.changed();
  }

  /**
   * The motion coordinator's state (5 times a second, and at once on a change). Remembers which way each lift
   * target goes from when it was first seen, and shows Done, Stopped or Not started when a motion ends.
   */
  motion(state: MotionState): void {
    const now = this.deps.clock.monotonic();
    const before = this.model.motion;
    const directions = new Map(before?.directions ?? []);
    const isHeld = (kind: string) => kind === "lift.home" || kind === "lift.move";
    const lift = state.active && isHeld(state.active.kind) ? (state.active as { kind: string; target_id: string; target_mm?: number }) : null;
    const action = lift ?? (state.confirm_target && isHeld(state.confirm_target.action.kind) ? state.confirm_target.action : null);
    const id = lift?.target_id ?? state.confirm_target?.target_id;
    if (action && id && !directions.has(id)) directions.set(id, liftDirection(action, state.lift));
    // Only the latest few targets matter: an old one never comes back.
    while (directions.size > 8) directions.delete(directions.keys().next().value!);
    const ended = endedBetween(before && now - before.atMono < SCREEN_MOTION_STALE_MS ? before.state : null, state);
    if (ended) this.model.motionEnded = { content: ended, untilMono: now + SCREEN_DONE_MS };
    this.model.motion = { state, atMono: now, directions: directions as ReadonlyMap<string, ScreenHoldDirection> };
    this.changed();
  }

  /**
   * Fresh zones, at the sensor's rate. Near uses the cue policy's thresholds and hysteresis. Entering or
   * leaving "Something close" is sent at once; a distance change at most every SCREEN_ZONES_MIN_MS.
   */
  zones(zones: readonly ScreenZone[]): void {
    const now = this.deps.clock.monotonic();
    const seen = new Set<string>();
    let nearest: ScreenZone | null = null;
    for (const zone of zones) {
      seen.add(zone.zone);
      const was = this.near.get(zone.zone) ?? false;
      const isNear = zone.quality === "valid" && zone.mm !== null && (was ? zone.mm <= NEAR_EXIT_MM : zone.mm < NEAR_ENTER_MM);
      this.near.set(zone.zone, isNear);
      if (isNear && (!nearest || zone.mm! < nearest.mm!)) nearest = zone;
    }
    for (const name of this.near.keys()) if (!seen.has(name)) this.near.set(name, false);

    const before = this.model.obstacle;
    const wasNear = before?.near ?? false;
    if (nearest) {
      this.model.obstacle = { zone: nearest.zone, mm: Math.round(nearest.mm! / 10) * 10, simulated: nearest.simulated, lastNearMono: now, near: true };
    } else if (before) {
      // The tail keeps the last near distance, or says Unknown when that zone's reading is now invalid or gone.
      const same = zones.find((z) => z.zone === before.zone);
      const unknown = !same || same.quality !== "valid" || same.mm === null;
      this.model.obstacle = { ...before, near: false, mm: unknown ? null : before.mm };
    }
    // Zones come only with readings: if a near zone's sensor goes quiet, its reading goes stale (unknown).
    this.cancelStale?.();
    this.cancelStale = this.model.obstacle?.near ? this.deps.clock.setTimeout(() => this.guard(() => this.zones([])), ZONE_VALIDITY_MS) : null;
    const entering = (this.model.obstacle?.near ?? false) !== wasNear;
    if (entering || now - this.lastZonesSent >= SCREEN_ZONES_MIN_MS) {
      this.lastZonesSent = now;
      this.changed();
    } else if (!this.cancelZones) {
      this.cancelZones = this.deps.clock.setTimeout(() => {
        this.cancelZones = null;
        this.lastZonesSent = this.deps.clock.monotonic();
        this.changed();
      }, this.lastZonesSent + SCREEN_ZONES_MIN_MS - now);
    }
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelZones?.();
    this.cancelStale?.();
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.deps.onError(error as Error);
    }
  }

  /** Coalesces every change made in this turn of the event loop into one recompute. */
  private changed(): void {
    if (this.queued || this.stopped) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.recompute();
    });
  }

  private recompute(): void {
    if (this.stopped) return;
    try {
      const now = this.deps.clock.monotonic();
      const settings = this.deps.settings;
      const { content, nextAt } = pickScreen(this.model, now, settings);
      const local = this.deps.localTime();
      // Bench mode is fixed when the coordinator starts, so the last state says it even once it is stale.
      const strip = { link: this.model.link, simulator: this.deps.simulator, bench_mode: this.model.motion?.state.bench_mode ?? false, clock: local ? { local_time: local } : null };
      // The strip's clock shows minutes only, so seconds never cause a redraw.
      const key = JSON.stringify([content, settings, { ...strip, clock: local?.slice(0, 16) ?? null }]);
      if (key !== this.lastKey) {
        this.lastKey = key;
        this.revision += 1;
        this.last = { v: 1, revision: this.revision, screen: content, settings, strip };
        this.deps.onState(this.last);
      }
      this.schedule(now, nextAt, local !== null);
    } catch (error) {
      this.deps.onError(error as Error);
    }
  }

  /** One timer: the next page, end or tail; the next minute while a time is shown, or a recheck every 30 s until the clock syncs. */
  private schedule(now: number, nextAt: number | null, clockShown: boolean): void {
    let at = nextAt;
    const wall = this.deps.clock.now();
    const clockAt = clockShown ? now + (Math.floor(wall / 60_000) + 1) * 60_000 - wall : now + CLOCK_RECHECK_MS;
    at = at === null ? clockAt : Math.min(at, clockAt);
    if (at === this.timerAt) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.timerAt = at;
    if (at === null) return;
    this.cancelTimer = this.deps.clock.setTimeout(() => {
      this.cancelTimer = null;
      this.timerAt = null;
      this.recompute();
    }, Math.max(0, at - now));
  }
}
