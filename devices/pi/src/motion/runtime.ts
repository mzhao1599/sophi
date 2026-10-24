import { join } from "node:path";
import type { Bus } from "../bus";
import type { GpiomonFlavor } from "../buttons";
import type { Clock } from "../clock";
import type { Logger } from "../log";
import { MotionCoordinator } from "./coordinator";
import { openFeetechPort } from "./feetech/port";
import { MotionFiles } from "./files";
import { DEFAULT_MOTION_SOCKET, OperatorSocket } from "./operator";
import type { MotionSettings } from "./settings";
import { GpioStopSense, NotWiredStopSense } from "./stopSense";

/**
 * The motion coordinator on the real Pi: real Feetech ports (by-id paths), the GPIO stop-sense input (or none),
 * and the operator socket in the service's runtime folder. Not yet run on a Pi with arms.
 */
export function createPiMotion(options: {
  settings: MotionSettings;
  stateDir: string;
  runtimeDir: string | undefined;
  clock: Clock;
  log: Logger;
  bus: Bus;
  gpio: { flavor: GpiomonFlavor; chip: string };
  handControls: () => boolean;
  walkerProposalOpen: () => boolean;
  say: (text: string) => void;
}): { coordinator: MotionCoordinator; socket: OperatorSocket } {
  const { settings, clock, log, bus } = options;
  const stopSense =
    settings.stopSense.kind === "gpio"
      ? new GpioStopSense({ flavor: options.gpio.flavor, chip: options.gpio.chip, line: settings.stopSense.line }, { clock, log })
      : new NotWiredStopSense();
  const coordinator = new MotionCoordinator({
    clock,
    log,
    bus,
    files: new MotionFiles(options.stateDir, log),
    arms: settings.arms.map((arm) => ({ side: arm.side, role: arm.role, busId: arm.busId, openPort: () => openFeetechPort(arm.path) })),
    stopSense,
    bench: settings.bench,
    handControls: options.handControls,
    walkerProposalOpen: options.walkerProposalOpen,
    say: options.say,
  });
  const socket = new OperatorSocket(options.runtimeDir ? join(options.runtimeDir, "motion.sock") : DEFAULT_MOTION_SOCKET, coordinator, log);
  return { coordinator, socket };
}
