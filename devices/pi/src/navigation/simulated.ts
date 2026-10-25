import type { LatLon } from "@walker/contracts";
import type { Cancel, Clock } from "../clock";
import { SIM_WALK_MPS } from "../constants";
import type { GpsResult } from "../gps";
import type { Logger } from "../log";
import { bearing, lengthOf, offsetPoint, pointAlong, polyline, snapTo, type Polyline } from "./geo";
import type { PositionSource } from "./position";

/** The phone's People nearby sample starting point, by Lake Merritt in Oakland. */
export const SIMULATED_START: LatLon = [37.8098, -122.2575];

/** How often the simulated position takes a step while it walks. */
const STEP_MS = 1_000;

/** WALKER_SIM_WALK_SPEEDUP: how many times faster than SIM_WALK_MPS the simulated position walks (default 3, 0.1 to 50). */
export function readWalkSpeedup(value: string | undefined): number {
  if (value === undefined || value === "") return 3;
  const speedup = Number(value);
  if (!Number.isFinite(speedup) || speedup < 0.1 || speedup > 50) throw new Error("WALKER_SIM_WALK_SPEEDUP must be a number from 0.1 to 50.");
  return speedup;
}

/**
 * A SIMULATED position for indoor demos and tests: the real receiver has no fix indoors (2026-10-24). It starts at
 * SIMULATED_START and, while a route is on, walks along it at SIM_WALK_MPS times the speed-up. It says it is
 * simulated (`simulated: true`): the manifest's GPS part, the screen and Sophi's words all say so, and the
 * service never puts it in a heartbeat, so a caretaker never sees a made-up position as hers.
 *
 * Script commands (`gps ...` in a `.walk` file) move it: `at`, `walk`, `offRoute`, `pause`, `resume`. After
 * `at` or `offRoute` it stays where it was put until the next route arrives (a new plan from there).
 */
export class SimulatedPosition implements PositionSource {
  readonly simulated = true;
  private position: LatLon;
  private line: Polyline | null = null;
  private along = 0;
  private holding = false;
  private paused = false;
  private waitingForDirections = false;
  private tracking = false;
  private cancel: Cancel | null = null;
  private readonly speed: number;

  constructor(
    private readonly clock: Clock,
    private readonly log: Logger,
    options: { start?: LatLon; speedup?: number } = {},
  ) {
    this.position = options.start ?? SIMULATED_START;
    this.speed = SIM_WALK_MPS * (options.speedup ?? 3);
  }

  connected(): boolean {
    return true;
  }

  /** Sharing makes no difference: a simulated position is never shared. */
  setEnabled(): void {}

  track(on: boolean): void {
    this.tracking = on;
    if (on && !this.cancel) this.schedule();
    if (!on) {
      this.cancel?.();
      this.cancel = null;
    }
  }

  current(): { latitude: number; longitude: number; age_ms: number } {
    return { latitude: this.position[0], longitude: this.position[1], age_ms: 0 };
  }

  onDemand(): Promise<GpsResult> {
    return Promise.resolve({ status: "fix", latitude: this.position[0], longitude: this.position[1] });
  }

  follow(route: LatLon[] | null): void {
    this.line = route && route.length >= 2 ? polyline(route) : null;
    this.along = this.line ? snapTo(this.line, this.position, 0).along : 0;
    this.holding = false;
  }

  waitForDirections(waiting: boolean): void {
    this.waitingForDirections = waiting;
  }

  stop(): void {
    this.track(false);
  }

  // ---- Script commands ----

  at(latitude: number, longitude: number): void {
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new Error("gps at needs a latitude and a longitude.");
    this.position = [latitude, longitude];
    this.holding = true;
    this.log.info("SIMULATED GPS put at a new position");
  }

  /** Moves `metres` ahead along the route (or north with no route). */
  walk(metres: number): void {
    if (this.line && !this.holding) {
      this.along = Math.min(lengthOf(this.line), this.along + metres);
      this.position = pointAlong(this.line, this.along);
    } else this.position = offsetPoint(this.position, metres, 0);
    this.log.info("SIMULATED GPS walked", { metres: Math.round(metres) });
  }

  /** Steps `metres` to the right of the route, square to it, and stays there. */
  offRoute(metres: number): void {
    const line = this.line;
    if (line) {
      const ahead = pointAlong(line, Math.min(lengthOf(line), this.along + 5));
      const behind = pointAlong(line, Math.max(0, this.along - 5));
      this.position = offsetPoint(this.position, metres, bearing(behind, ahead) + 90);
    } else this.position = offsetPoint(this.position, metres, 90);
    this.holding = true;
    this.log.info("SIMULATED GPS stepped off the route", { metres: Math.round(metres) });
  }

  pause(): void {
    this.paused = true;
    this.log.info("SIMULATED GPS paused");
  }

  resume(): void {
    this.paused = false;
    this.log.info("SIMULATED GPS walking again");
  }

  private schedule(): void {
    this.cancel = this.clock.setTimeout(() => {
      this.cancel = null;
      if (this.line && !this.paused && !this.holding && !this.waitingForDirections) {
        this.along = Math.min(lengthOf(this.line), this.along + (this.speed * STEP_MS) / 1000);
        this.position = pointAlong(this.line, this.along);
      }
      if (this.tracking) this.schedule();
    }, STEP_MS);
  }
}
