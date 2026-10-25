import type { LatLon } from "@walker/contracts";
import type { GpsResult } from "../gps";

/**
 * Where the walker is: the USB GPS (`GpsSampler`) or, for indoor demos and tests, the simulated position
 * (`SimulatedPosition`). The service's `location` dependency. Two separate reasons to keep reading it:
 * caretaker sharing (`setEnabled`, the owner's phone turns it on; the heartbeat carries a real fix) and an active
 * route (`track`, so guidance keeps going offline, when sharing is off).
 */
export interface PositionSource {
  /** The simulated position: labelled Simulated everywhere, and never sent in a heartbeat. */
  readonly simulated: boolean;
  /** A receiver is attached (not proof of a fix). The simulated one always is. */
  connected(): boolean;
  /** Caretaker sharing on or off. */
  setEnabled(enabled: boolean): void;
  /** Keep reading while a route is on (about once a second), whatever sharing says. */
  track(on: boolean): void;
  /** The latest fix while sharing or tracking, if fresh; else null. */
  current(): { latitude: number; longitude: number; age_ms: number } | null;
  /** One fix for a question she asked ("Where am I?", a route), without turning sharing on. */
  onDemand(signal: AbortSignal): Promise<GpsResult>;
  /** The route she is on, or null: the simulated position walks along it. A real receiver ignores it. */
  follow?(route: LatLon[] | null): void;
  stop(): void;
}
