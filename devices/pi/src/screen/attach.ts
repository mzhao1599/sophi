import {
  CircleNameSchema,
  DEFAULT_SCREEN_CHOICES,
  NavigatingScreenSchema,
  type AppliedScreenSettings,
  type ScreenState,
} from "@walker/contracts";
import type { Bus, BusEvents } from "../bus";
import type { Clock } from "../clock";
import type { Logger } from "../log";
import type { ModuleManager } from "../serial/modules";
import type { WalkerService } from "../service";
import { ScreenMachine } from "./machine";

/**
 * Connects the screen's state machine to the walker service's bus. Every listener is wrapped, so nothing the
 * screen does can throw into Talk, Confirm, the heartbeat or the cues (the bus calls listeners in line), and
 * a failure is logged once per kind, never with the state, her words or the reply.
 */
export interface ScreenAttachDeps {
  bus: Bus;
  clock: Clock;
  log: Logger;
  service: Pick<WalkerService, "link" | "talk" | "configuration" | "openProposal">;
  modules: Pick<ModuleManager, "modules">;
  simulator: boolean;
  settings: AppliedScreenSettings;
  localTime: () => string | null;
  /** Each new state (for the screen server). */
  onState: (state: ScreenState) => void;
}

/** Her settings until the circle feed brings real ones: version 1 is the defaults, with an optional greeting. */
export function startingSettings(greeting: string | undefined, nowMs: number): AppliedScreenSettings {
  const name = greeting ? CircleNameSchema.safeParse(greeting) : null;
  return {
    version: 1,
    ...DEFAULT_SCREEN_CHOICES,
    greeting_name: name?.success ? name.data : null,
    changed_at: new Date(nowMs).toISOString(),
    pending_local: false,
  };
}

export function attachScreen(deps: ScreenAttachDeps): { machine: ScreenMachine; detach: () => void } {
  const failed = new Set<string>();
  const fail = (where: string, error: unknown) => {
    if (failed.has(where)) return;
    failed.add(where);
    deps.log.warn("walker screen error; the walker carries on", { where, error: (error as Error)?.name ?? "unknown" });
  };
  const machine = new ScreenMachine({
    clock: deps.clock,
    simulator: deps.simulator,
    settings: deps.settings,
    localTime: deps.localTime,
    onState: (state) => {
      try {
        deps.onState(state);
      } catch (error) {
        fail("publish", error);
      }
      try {
        deps.bus.emit("screen", { state: state.screen.state, revision: state.revision });
      } catch (error) {
        fail("screen event", error);
      }
    },
    onError: (error) => fail("machine", error),
  });

  const offs: Array<() => void> = [];
  const on = <K extends keyof BusEvents>(name: K, fn: (payload: BusEvents[K]) => void) =>
    offs.push(
      deps.bus.on(name, (payload) => {
        try {
          fn(payload);
        } catch (error) {
          fail(name, error);
        }
      }),
    );

  on("link", ({ state }) => machine.link(state));
  on("talk", ({ state }) => machine.talk(state));
  on("config", () => machine.alerts(deps.service.configuration ? [...deps.service.configuration.cues] : null));
  on("answer", (answer) => machine.answer(answer));
  on("answerSpoken", ({ id }) => machine.answerSpoken(id));
  on("circleMessage", (message) => machine.message(message));
  on("circleMessageSpoken", ({ id }) => machine.messageSpoken(id));
  on("offer", ({ proposal }) => machine.offer(proposal));
  on("settled", ({ result }) => machine.settled(result));
  on("confirming", ({ phase }) => machine.confirm(phase));
  on("motionState", ({ state }) => machine.motion(state));
  // The Navigator's view is checked against the contract here, so the page never gets a state it would drop (it
  // keeps the last good one). A view that fails is logged once, by kind only (it holds coordinates and a place
  // name), and the screen shows no route rather than a stale one.
  on("navigation", ({ view }) => {
    if (view === null) return machine.navigation(null);
    const parsed = NavigatingScreenSchema.safeParse(view);
    if (!parsed.success) {
      fail("navigation view", new TypeError("not a NavigatingScreen"));
      return machine.navigation(null);
    }
    machine.navigation(parsed.data);
  });
  on("help", ({ screen }) => machine.help(screen));
  on("zones", ({ zones }) => {
    const simulated = new Map(deps.modules.modules().map((m) => [m.instanceId, m.simulated]));
    machine.zones(zones.map((z) => ({ zone: z.zone, mm: z.mm, quality: z.quality, simulated: simulated.get(z.instanceId) ?? false })));
  });

  return {
    machine,
    detach: () => {
      for (const off of offs) off();
      machine.stop();
    },
  };
}

/** Seeds the machine from the service once it has started (its configuration is read in `start`). */
export function seedScreen(machine: ScreenMachine, service: ScreenAttachDeps["service"]): void {
  machine.seed({
    link: service.link,
    talk: service.talk,
    alerts: service.configuration ? [...service.configuration.cues] : null,
    offer: service.openProposal,
  });
}
