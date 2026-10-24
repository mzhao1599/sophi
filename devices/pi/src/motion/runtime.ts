import { join } from "node:path";
import type { Bus } from "../bus";
import type { GpiomonFlavor } from "../buttons";
import type { Clock } from "../clock";
import type { Logger } from "../log";
import type { ModuleManager } from "../serial/modules";
import { MotionCoordinator } from "./coordinator";
import { openFeetechPort } from "./feetech/port";
import { MotionFiles } from "./files";
import { LiftClient } from "./lift";
import { DEFAULT_MOTION_SOCKET, OperatorSocket } from "./operator";
import type { MotionSettings } from "./settings";
import { GpioStopSense, NotWiredStopSense } from "./stopSense";

/**
 * The motion coordinator on the real Pi: real Feetech ports (by-id paths), the GPIO stop-sense input (or none),
 * the lift when `<state>/motion/lift.json` says one is fitted, and the operator socket in the service's runtime
 * folder. Not yet run on a Pi with arms or a lift.
 *
 * The lift: its client is built from that file's configuration and installation record, and registered with the
 * module manager as the handler for lift ports. Call this before the serial scanner starts, so the lift board's
 * first lines already have their handler.
 */
export function createPiMotion(options: {
  settings: MotionSettings;
  stateDir: string;
  runtimeDir: string | undefined;
  clock: Clock;
  log: Logger;
  bus: Bus;
  /** The serial modules: the lift board is one, found by its `lift.hello`. */
  modules: Pick<ModuleManager, "setLiftHandler">;
  gpio: { flavor: GpiomonFlavor; chip: string };
  handControls: () => boolean;
  walkerProposalOpen: () => boolean;
  say: (text: string) => void;
}): { coordinator: MotionCoordinator; socket: OperatorSocket; lift: LiftClient | null } {
  const { settings, clock, log, bus } = options;
  const files = new MotionFiles(options.stateDir, log);
  const liftLoad = files.readLift();
  const lift = liftLoad.kind === "ok" ? new LiftClient({ log, setup: liftLoad.setup, bench: settings.bench, monotonic: () => clock.monotonic() }) : null;
  if (lift) options.modules.setLiftHandler(lift);
  const liftAbsent = liftLoad.kind === "invalid" ? liftLoad.reason : "no lift.json";
  if (lift) log.info("lift fitted (lift.json): the motion coordinator drives it");
  else if (liftLoad.kind === "missing") log.info("no lift (no lift.json)");
  else log.error("the lift is off", { reason: liftAbsent });
  const stopSense =
    settings.stopSense.kind === "gpio"
      ? new GpioStopSense({ flavor: options.gpio.flavor, chip: options.gpio.chip, line: settings.stopSense.line }, { clock, log })
      : new NotWiredStopSense();
  const coordinator = new MotionCoordinator({
    clock,
    log,
    bus,
    files,
    arms: settings.arms.map((arm) => ({ side: arm.side, role: arm.role, busId: arm.busId, openPort: () => openFeetechPort(arm.path) })),
    stopSense,
    bench: settings.bench,
    handControls: options.handControls,
    walkerProposalOpen: options.walkerProposalOpen,
    say: options.say,
    lift,
    liftAbsent,
  });
  const socket = new OperatorSocket(options.runtimeDir ? join(options.runtimeDir, "motion.sock") : DEFAULT_MOTION_SOCKET, coordinator, log);
  return { coordinator, socket, lift };
}
