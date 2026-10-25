import { NAVIGATION_MAP_POINTS, type LatLon, type NavigatingScreen, type NavigationPhase, type RouteSummary } from "@walker/contracts";
import type { Cancel, Clock } from "../clock";
import {
  NAV_AHEAD_M,
  NAV_ARRIVE_M,
  NAV_ARRIVED_HOLD_MS,
  NAV_LOST_MS,
  NAV_NOW_M,
  NAV_OFF_ROUTE_M,
  NAV_POSITION_MAX_AGE_MS,
  NAV_REROUTE_GAP_MS,
  NAV_REROUTES_MAX,
  NAV_TICK_MS,
} from "../constants";
import type { Logger } from "../log";
import { lineAhead, snapTo } from "./geo";
import type { Place } from "./places";
import { distanceWords, roughDistanceWords, walkingMinutes, type Route, type RouteOutcome } from "./route";

/**
 * A line of walking directions for the service to say. `kind` and `step` let the service drop a line that is
 * no longer true by the time it could be said (she passed that turn while Talk was held): see `due`.
 */
export interface GuidanceLine {
  text: string;
  kind: "ahead" | "now" | "status";
  step: number;
  /** The route it belongs to (a new plan or an end makes older lines stale). */
  epoch: number;
  /** Monotonic time it was made. */
  at: number;
  /** For a line about a phase ("off the route", "lost the position"): said only while guidance is still in it. */
  phase?: NavigationPhase;
}

export interface NavigatorDeps {
  clock: Clock;
  log: Logger;
  /** Her latest position from the position source (real or simulated), or null. */
  position: () => { latitude: number; longitude: number; age_ms: number } | null;
  /** The position source is the simulated one. */
  simulated: boolean;
  /** Plans again from her position to the same place (the walking router, with its own deadline). */
  replan: (from: LatLon, place: Place, signal: AbortSignal) => Promise<RouteOutcome>;
  /** A line to say; the service decides when (it waits behind Talk, answers and messages). */
  say: (line: GuidanceLine) => void;
  /** What the walker screen draws (the bus `navigation` event), or null once no route is on. */
  view: (view: NavigatingScreen | null) => void;
  /** The route she is now on (started, or planned again), or null once it ended. */
  routeChanged: (route: Route | null) => void;
}

const round10 = (metres: number) => Math.max(0, Math.round(metres / 10) * 10);
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const NAV_LINES = {
  offRoute: "You seem to be off the route. Finding the way again.",
  noWay: "I can't find the way from here.",
  lost: "I've lost the GPS position. I'll keep trying.",
  osm: "Directions come from OpenStreetMap and may include steps or curbs.",
} as const;

/**
 * Follows one walking route: on every new position it snaps her to the route, works out how far along it she
 * is (progress along the route, not a radius around each turn, so a fast walk can't skip one between
 * samples) and makes the spoken lines: each step once ahead and once at it, planning again when she leaves
 * the route, the lost-position line, and the arrival, kept on screen a while before the route ends.
 *
 * Pure logic on an injected clock: the position comes from `deps.position`, lines go to `deps.say`, the screen's
 * view to `deps.view`. Nothing here is a model output, and nothing moves a motor: directions are advice.
 */
export class Navigator {
  private route: Route | null = null;
  private epoch = 0;
  private phase: NavigationPhase = "guiding";
  /** Metres along the route to her snapped position. */
  private progress = 0;
  private position: LatLon | null = null;
  /** The index of the next step to do (the departure, step 0, is in the first line). */
  private next = 1;
  private readonly aheadSaid = new Set<number>();
  private readonly nowSaid = new Set<number>();
  private lastFixAt = 0;
  private lostSaid = false;
  private offCount = 0;
  private reroutes = 0;
  private lastRerouteAt = -Infinity;
  private rerouting: AbortController | null = null;
  private offSaid = false;
  private noWaySaid = false;
  private cancelTick: Cancel | null = null;
  private cancelArrived: Cancel | null = null;
  private lastView = "";

  constructor(private readonly deps: NavigatorDeps) {}

  active(): boolean {
    return this.route !== null;
  }

  /** Starts guidance on `route` from her position `from`, replacing any route on. */
  start(route: Route, from: LatLon): void {
    if (this.route) this.clear();
    this.reroutes = 0;
    this.lastRerouteAt = -Infinity;
    this.adopt(route, from);
    this.lastFixAt = this.deps.clock.monotonic();
    this.lostSaid = false;
    this.deps.log.info("route started", { steps: route.steps.length, metres: round10(route.length) });
    this.emitView();
    this.scheduleTick();
  }

  /** Ends the route, if one is on: the view goes, waiting lines go stale. Returns the place it was going to. */
  stop(why: string): Place | null {
    const place = this.route?.place ?? null;
    if (!place) return null;
    this.clear();
    this.deps.log.info("route ended", { why });
    this.emitView();
    this.deps.routeChanged(null);
    return place;
  }

  /** The Pi's own first line, said once the turn's reply has finished. */
  introLine(): GuidanceLine | null {
    const route = this.route;
    if (!route) return null;
    // A simulated position says so out loud too, not only on the screen: she must never hear made-up guidance as real.
    const simulated = this.deps.simulated ? "On the simulated position: " : "";
    const text = `${simulated}Walking to ${route.place.spoken}, about ${roughDistanceWords(route.length)}. ${route.steps[0]!.instruction} ${NAV_LINES.osm}`;
    return this.line(text, "status", 0);
  }

  /** The next instruction again (Confirm with nothing else to confirm, or the screen's Repeat). */
  repeatLine(): GuidanceLine | null {
    const route = this.route;
    if (!route) return null;
    switch (this.phase) {
      case "arrived":
        return this.line(`You've arrived near ${route.place.spoken}.`, "status", this.next);
      case "rerouting":
        return this.line("I'm finding the way again.", "status", this.next);
      case "off_route":
        return this.line(NAV_LINES.noWay, "status", this.next);
      case "no_position":
        return this.line(`${NAV_LINES.lost} The next step: ${lowerFirst(route.steps[this.next]!.instruction)}`, "status", this.next);
      case "guiding": {
        const to = route.steps[this.next]!.along - this.progress;
        return to <= NAV_NOW_M && this.next < route.steps.length - 1 ? this.line(this.nowText(this.next), "status", this.next) : this.line(this.aheadText(this.next, to), "status", this.next);
      }
    }
  }

  /** Whether a line made earlier is still true now: same route, and (for a step's line) that step is still ahead. */
  due(line: GuidanceLine): boolean {
    if (!this.route || line.epoch !== this.epoch) return false;
    if (line.kind === "ahead") return this.next === line.step && this.phase === "guiding";
    if (line.kind === "now") return this.next <= line.step + 1 && this.deps.clock.monotonic() - line.at < 10_000;
    return line.phase === undefined || line.phase === this.phase;
  }

  /** The route in progress as the model reads it (names and rounded distances; never coordinates), or null. */
  summary(): RouteSummary | null {
    const route = this.route;
    if (!route) return null;
    const view = this.view(route);
    return {
      destination: route.place.name,
      phase: this.phase,
      next: view.instruction,
      to_next_m: view.to_step_m,
      remaining_m: view.remaining_m,
      remaining_min: view.remaining_min,
      simulated: this.deps.simulated,
    };
  }

  // ---- Inside ----

  private line(text: string, kind: GuidanceLine["kind"], step: number, phase?: NavigationPhase): GuidanceLine {
    return { text, kind, step, epoch: this.epoch, at: this.deps.clock.monotonic(), ...(phase ? { phase } : {}) };
  }

  private say(text: string, kind: GuidanceLine["kind"], step: number, phase?: NavigationPhase): void {
    this.deps.say(this.line(text, kind, step, phase));
  }

  private aheadText(index: number, metres: number): string {
    const route = this.route!;
    const step = route.steps[index]!;
    const distance = distanceWords(Math.max(0, metres));
    return step.maneuver === "arrive" ? `In ${distance}, you'll be near ${route.place.spoken}.` : `In ${distance}, ${lowerFirst(step.instruction)}`;
  }

  private nowText(index: number): string {
    return `${capital(this.route!.steps[index]!.action)} now.`;
  }

  /** Takes `route` as the one she is on, from `from` (a start or a new plan). */
  private adopt(route: Route, from: LatLon): void {
    this.epoch += 1;
    this.route = route;
    this.phase = "guiding";
    this.position = from;
    this.progress = snapTo(route.line, from, 0).along;
    this.next = 1;
    this.aheadSaid.clear();
    this.nowSaid.clear();
    this.offCount = 0;
    this.offSaid = false;
    this.noWaySaid = false;
    this.deps.routeChanged(route);
  }

  private clear(): void {
    this.cancelTick?.();
    this.cancelTick = null;
    this.cancelArrived?.();
    this.cancelArrived = null;
    this.rerouting?.abort();
    this.rerouting = null;
    this.epoch += 1;
    this.route = null;
    this.position = null;
  }

  private scheduleTick(): void {
    this.cancelTick = this.deps.clock.setTimeout(() => this.tick(), NAV_TICK_MS);
  }

  private tick(): void {
    this.cancelTick = null;
    if (!this.route || this.phase === "arrived") return;
    const now = this.deps.clock.monotonic();
    const fix = this.deps.position();
    if (fix && fix.age_ms <= NAV_POSITION_MAX_AGE_MS && now - fix.age_ms > this.lastFixAt) {
      this.lastFixAt = now - fix.age_ms;
      this.onPosition([fix.latitude, fix.longitude]);
    }
    // onPosition may have ended guidance (the arrival): read the phase again.
    if (this.route && !this.arrived() && now - this.lastFixAt >= NAV_LOST_MS && !this.lostSaid) {
      this.lostSaid = true;
      this.phase = "no_position";
      this.deps.log.info("route position lost", { seconds: Math.round((now - this.lastFixAt) / 1000) });
      this.say(NAV_LINES.lost, "status", this.next, "no_position");
    }
    this.emitView();
    if (this.route && !this.arrived()) this.scheduleTick();
  }

  private arrived(): boolean {
    return this.phase === "arrived";
  }

  private onPosition(p: LatLon): void {
    const route = this.route!;
    this.position = p;
    if (this.lostSaid) {
      this.lostSaid = false;
      if (this.phase === "no_position") this.phase = "guiding";
    }
    const snap = snapTo(route.line, p, this.progress);
    if (snap.off > NAV_OFF_ROUTE_M) {
      this.offCount += 1;
      if (this.offCount >= 2) this.planAgain(p);
      return;
    }
    // Back on the route: whatever was being planned is no longer needed.
    this.offCount = 0;
    if (this.phase === "rerouting" || this.phase === "off_route") {
      this.rerouting?.abort();
      this.rerouting = null;
      this.phase = "guiding";
      this.offSaid = false;
      this.noWaySaid = false;
    }
    this.progress = snap.along;
    if (route.length - this.progress <= NAV_ARRIVE_M) {
      this.arrive();
      return;
    }
    // Every step reached (within NAV_NOW_M) or passed since the last position; only the latest is said.
    let passed = -1;
    while (this.next < route.steps.length - 1 && route.steps[this.next]!.along - this.progress <= NAV_NOW_M) {
      passed = this.next;
      this.nowSaid.add(this.next);
      this.next += 1;
    }
    if (passed >= 0) this.say(this.nowText(passed), "now", passed);
    const to = route.steps[this.next]!.along - this.progress;
    if (to <= NAV_AHEAD_M && !this.aheadSaid.has(this.next)) {
      this.aheadSaid.add(this.next);
      this.say(this.aheadText(this.next, to), "ahead", this.next);
    }
  }

  /** Plans again from `p`, at most every NAV_REROUTE_GAP_MS and NAV_REROUTES_MAX times a route. */
  private planAgain(p: LatLon): void {
    const route = this.route!;
    const now = this.deps.clock.monotonic();
    if (this.rerouting) return;
    if (this.reroutes >= NAV_REROUTES_MAX) {
      this.phase = "off_route";
      return;
    }
    if (now - this.lastRerouteAt < NAV_REROUTE_GAP_MS) return;
    this.reroutes += 1;
    this.lastRerouteAt = now;
    this.phase = "rerouting";
    this.deps.log.info("off the route; planning again", { attempt: this.reroutes });
    if (!this.offSaid) {
      this.offSaid = true;
      this.say(NAV_LINES.offRoute, "status", this.next, "rerouting");
    }
    const controller = new AbortController();
    this.rerouting = controller;
    const epoch = this.epoch;
    const failed = () => {
      this.phase = "off_route";
      this.deps.log.info("planning again failed", { attempt: this.reroutes });
      if (!this.noWaySaid) {
        this.noWaySaid = true;
        this.say(NAV_LINES.noWay, "status", this.next, "off_route");
      }
      this.emitView();
    };
    void this.deps.replan(p, route.place, controller.signal).then(
      (outcome) => {
        if (this.epoch !== epoch || controller.signal.aborted) return;
        this.rerouting = null;
        if (outcome.kind !== "ok") return failed();
        this.adopt(outcome.route, this.position ?? p);
        this.deps.log.info("planned again", { steps: outcome.route.steps.length, metres: round10(outcome.route.length) });
        this.say(outcome.route.steps[0]!.instruction, "status", 0);
        this.emitView();
      },
      () => {
        if (this.epoch !== epoch || controller.signal.aborted) return;
        this.rerouting = null;
        failed();
      },
    );
  }

  private arrive(): void {
    const route = this.route!;
    this.phase = "arrived";
    this.next = route.steps.length - 1;
    this.progress = route.length;
    this.cancelTick?.();
    this.cancelTick = null;
    this.deps.log.info("route arrived", { steps: route.steps.length });
    this.say(`You've arrived near ${route.place.spoken}.`, "status", this.next);
    this.emitView();
    this.cancelArrived = this.deps.clock.setTimeout(() => {
      this.cancelArrived = null;
      this.stop("arrived");
    }, NAV_ARRIVED_HOLD_MS);
  }

  private view(route: Route): NavigatingScreen {
    const step = route.steps[this.next]!;
    const remaining = Math.max(0, route.length - this.progress);
    const instruction =
      this.phase === "arrived" ? `You've arrived near ${route.place.spoken}.`
      : this.phase === "rerouting" ? "Finding the way again."
      : this.phase === "off_route" ? NAV_LINES.noWay
      : step.instruction;
    return {
      state: "navigating",
      destination: route.place.name,
      phase: this.phase,
      instruction: instruction.slice(0, 120),
      maneuver: this.phase === "arrived" ? "arrive" : step.maneuver,
      street: this.phase === "arrived" ? null : step.street,
      to_step_m: this.phase === "no_position" ? null : round10(step.along - this.progress),
      remaining_m: round10(remaining),
      remaining_min: walkingMinutes(remaining),
      simulated: this.deps.simulated,
      map: {
        position: this.position,
        route: lineAhead(route.line, this.progress, NAVIGATION_MAP_POINTS),
        step_at: step.maneuver === "arrive" || this.phase === "arrived" ? null : step.at,
        destination_at: route.place.at,
      },
    };
  }

  /** Sends the screen's view when it changed (it changes about once a second while she walks). */
  private emitView(): void {
    const view = this.route ? this.view(this.route) : null;
    const key = JSON.stringify(view);
    if (key === this.lastView) return;
    this.lastView = key;
    this.deps.view(view);
  }
}
