import { RECENT_TURNS, WALKER_HISTORY_RETENTION_MS, type WalkerActivityView, type WalkerTurnInFlight, type WalkerTurnTrace } from "@walker/contracts";

/** The contract allows at most this many in-flight turns per walker; a fifth at once isn't shown (its trace still is). */
export const MAX_IN_FLIGHT = 4;

type Stage = WalkerTurnInFlight["stage"];

interface Flight {
  entry: Omit<WalkerTurnInFlight, "stage">;
  /** One per upload of this client_turn_id still running, in arrival order; the first one's stage is shown. */
  owners: Map<symbol, Stage>;
}

interface DeviceActivity {
  flights: Map<string, Flight>;
  /** Uploads begun and not yet ended, shown or not: the entry stays while any is running. */
  holds: number;
  /** Oldest first. */
  traces: WalkerTurnTrace[];
}

/** One upload's hold on its walker's entry. Every method is safe to call after the walker was forgotten. */
export interface FlightHandle {
  stage(stage: Stage): void;
  /** Records the trace of a turn that saved a new row, unless the walker was forgotten since it began. */
  record(trace: WalkerTurnTrace): void;
  /** Releases this upload; its in-flight entry goes when the last upload of that turn ends. Call it in a `finally`. */
  end(): void;
}

/**
 * What the server itself saw of each walker's turns, for the /walker page's live companion: turns it is
 * working on now, and how recent saved turns went (timings, rule codes, who answered and voiced). Never
 * anyone's words. It lives only in this process's memory, so a restart empties it, and it is bounded:
 * at most MAX_IN_FLIGHT in-flight turns and RECENT_TURNS traces per walker, none older than
 * WALKER_HISTORY_RETENTION_MS. Only the owner's list route reads it, for that owner's own walkers.
 */
export class ActivityLog {
  private readonly devices = new Map<string, DeviceActivity>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** A turn the server has accepted; returns the handle that moves its stage, records its trace and ends it. */
  begin(deviceId: string, entry: Omit<WalkerTurnInFlight, "stage">): FlightHandle {
    let device = this.devices.get(deviceId);
    if (!device) this.devices.set(deviceId, (device = { flights: new Map(), holds: 0, traces: [] }));
    const mine = device;
    mine.holds++;
    const id = entry.client_turn_id;
    let flight = mine.flights.get(id);
    if (!flight && mine.flights.size < MAX_IN_FLIGHT) mine.flights.set(id, (flight = { entry: { ...entry }, owners: new Map() }));
    const owner = Symbol("upload");
    flight?.owners.set(owner, "hearing");
    let ended = false;
    // Still running, and its walker not forgotten since (a forget replaces the entry or removes it).
    const current = () => !ended && this.devices.get(deviceId) === mine;
    return {
      stage: (stage) => {
        if (current() && flight?.owners.has(owner)) flight.owners.set(owner, stage);
      },
      record: (trace) => {
        if (!current()) return;
        mine.traces.push({ ...trace });
        this.prune();
      },
      end: () => {
        if (ended) return;
        ended = true;
        mine.holds--;
        if (flight?.owners.delete(owner) && flight.owners.size === 0 && mine.flights.get(id) === flight) mine.flights.delete(id);
        this.drop(deviceId);
      },
    };
  }

  /** On Forget: everything about the walker goes at once. */
  forget(deviceId: string) {
    this.devices.delete(deviceId);
  }

  /** The given walkers' activity, in the given order, leaving out walkers with nothing to show. */
  view(deviceIds: string[]): WalkerActivityView[] {
    this.prune();
    const views: WalkerActivityView[] = [];
    for (const device_id of deviceIds) {
      const d = this.devices.get(device_id);
      if (!d || (d.flights.size === 0 && d.traces.length === 0)) continue;
      const in_flight = [...d.flights.values()].map((f) => ({ ...f.entry, stage: f.owners.values().next().value ?? "hearing" }));
      views.push({ device_id, in_flight, traces: d.traces.map((t) => ({ ...t })) });
    }
    return views;
  }

  /** Drops traces past retention or past the per-walker cap, and walkers left with nothing. */
  private prune() {
    const since = this.now().getTime() - WALKER_HISTORY_RETENTION_MS;
    for (const [id, d] of this.devices) {
      d.traces = d.traces.filter((t) => Date.parse(t.at) >= since).slice(-RECENT_TURNS);
      this.drop(id);
    }
  }

  private drop(deviceId: string) {
    const d = this.devices.get(deviceId);
    if (d && d.holds === 0 && d.traces.length === 0) this.devices.delete(deviceId);
  }
}
