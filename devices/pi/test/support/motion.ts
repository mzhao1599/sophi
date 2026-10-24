import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MotionStateSchema, type MotionState } from "@walker/contracts";
import { Bus } from "../../src/bus";
import { handControlsConnected } from "../../src/motion/handControls";
import { ModuleManager } from "../../src/serial/modules";
import { WalkerService } from "../../src/service";
import { SimulatedHand, SimulatedPort } from "../../src/sim/fakeModules";
import { FakeCloud, FakeCloudClient } from "../../src/sim/fakeCloud";
import { MotionSim, type MotionSimHand } from "../../src/sim/motionSim";
import { ScriptRunner } from "../../src/sim/script";
import { StateStore } from "../../src/store";
import { FakeCapture, FakeClock, FakeSpeaker, captureLogger, flush } from "./fakes";

/**
 * The walker service with SIMULATED arms on a fake clock: the same MotionSim `walker simulate --arms` uses,
 * a simulated handle, and an unpaired service (the motion path needs no cloud). Every published motion state is
 * checked against the contract's MotionStateSchema.
 */
export function makeMotionHarness(options: { bench?: boolean; stateDir?: string } = {}) {
  const clock = new FakeClock();
  const bus = new Bus();
  const log = captureLogger();
  const dir = options.stateDir ?? mkdtempSync(join(tmpdir(), "walker-motion-test-"));
  const store = new StateStore(dir, log);
  const modules = new ModuleManager({ clock, log, bus });
  const runner = new ScriptRunner(bus);
  let port = new SimulatedPort("sim:hand-right");
  let hand = new SimulatedHand(port, "hand-right-sim", clock);
  modules.attach(port);
  hand.start();
  const handControl: MotionSimHand = {
    get plugged() {
      return hand.isRunning;
    },
    unplug() {
      hand.hang();
      port.unplug();
    },
    plug() {
      port = new SimulatedPort("sim:hand-right");
      hand = new SimulatedHand(port, "hand-right-sim", clock);
      modules.attach(port);
      hand.start();
    },
  };
  let ids = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
  let announce: (text: string) => void = () => {};
  const sim = new MotionSim({
    clock,
    log,
    bus,
    stateDir: dir,
    bench: options.bench ?? false,
    hand: handControl,
    handControls: () => handControlsConnected(modules, null),
    walkerProposalOpen: (): boolean => service.hasOpenProposal(),
    say: (text) => announce(text),
    newId,
  });
  const fake = new FakeCloud(clock, ["vibration", "spoken"]);
  const service = new WalkerService({
    clock,
    log,
    bus,
    store,
    modules,
    capture: new FakeCapture(clock),
    speaker: new FakeSpeaker(),
    simulator: true,
    audioInstanceId: "test-audio",
    coordinatorInstanceId: "sim-coordinator",
    motion: sim.coordinator,
    newId,
    makeCloud: (file) => new FakeCloudClient(fake, file.device_id, file.credential),
  });
  announce = (text) => service.announce(text);
  const states: MotionState[] = [];
  const invalid: string[] = [];
  bus.on("motionState", ({ state }) => {
    states.push(state);
    const parsed = MotionStateSchema.safeParse(state);
    if (!parsed.success) invalid.push(parsed.error.issues[0]?.message ?? "invalid");
  });
  bus.on("motion", ({ kind, text }) => {
    if (kind === "state-invalid") invalid.push(text);
  });
  const actions = sim.actions();
  const press = (key: string) => {
    if (key === "t") return bus.emit("button", { button: "talk", edge: "pressed", source: "keyboard" });
    if (key === "c") return bus.emit("button", { button: "confirm", edge: "pressed", source: "keyboard" });
    if (key === "q") return;
    const action = actions[key];
    if (!action) throw new Error(`unknown script key ${key}`);
    action();
  };
  return {
    clock,
    bus,
    log,
    dir,
    sim,
    coordinator: sim.coordinator,
    service,
    modules,
    runner,
    states,
    invalid,
    press,
    get hand() {
      return hand;
    },
    async start(): Promise<void> {
      service.start();
      const started = sim.coordinator.start();
      await clock.advance(300);
      await started;
      await flush();
    },
    async stop(): Promise<void> {
      const stopped = sim.stop();
      await clock.advance(400);
      await stopped;
      service.stop();
      hand.hang();
      modules.stop();
    },
  };
}

export type MotionHarness = ReturnType<typeof makeMotionHarness>;
