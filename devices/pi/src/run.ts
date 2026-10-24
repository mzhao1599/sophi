import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arecordCapture } from "./audio/capture";
import { PiSpeaker, writeCueSounds } from "./audio/speech";
import { Bus } from "./bus";
import { GpioButtons, type GpiomonFlavor } from "./buttons";
import { systemClock } from "./clock";
import { HttpCloudClient } from "./cloud/client";
import { createLogger } from "./log";
import { attachLogging } from "./logging";
import { ModuleManager } from "./serial/modules";
import { SERIAL_BY_ID_DIR, SerialScanner } from "./serial/port";
import { WalkerService } from "./service";
import { StateStore } from "./store";

/**
 * Settings for the real walker, from environment variables (the systemd unit reads them from
 * /etc/steady-walker.env). Pin numbers and device names are assumptions until Max checks them on the Pi.
 */
export interface PiConfig {
  stateDir: string;
  captureDevice: string;
  playbackDevice: string;
  piperModel: string | null;
  gpioChip: string;
  talkPin: number;
  confirmPin: number;
  gpiomon: GpiomonFlavor;
  serialDir: string;
}

export const DEFAULT_STATE_DIR = "/var/lib/steady-walker";

function pin(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 63) throw new Error(`${name} must be a GPIO line number.`);
  return number;
}

export function readPiConfig(env: NodeJS.ProcessEnv): PiConfig {
  const captureDevice = env.WALKER_ALSA_CAPTURE ?? "";
  const playbackDevice = env.WALKER_ALSA_PLAYBACK ?? "";
  if (!captureDevice || !playbackDevice) {
    throw new Error("Set WALKER_ALSA_CAPTURE and WALKER_ALSA_PLAYBACK to ALSA device names (see devices/pi/README.md).");
  }
  const gpiomon = env.WALKER_GPIOMON ?? "v1";
  if (gpiomon !== "v1" && gpiomon !== "v2") throw new Error("WALKER_GPIOMON must be v1 or v2.");
  return {
    stateDir: env.WALKER_STATE_DIR || DEFAULT_STATE_DIR,
    captureDevice,
    playbackDevice,
    piperModel: env.WALKER_PIPER_MODEL || null,
    gpioChip: env.WALKER_GPIO_CHIP || "gpiochip0",
    talkPin: pin(env.WALKER_GPIO_TALK, 17, "WALKER_GPIO_TALK"),
    confirmPin: pin(env.WALKER_GPIO_CONFIRM, 27, "WALKER_GPIO_CONFIRM"),
    gpiomon,
    serialDir: env.WALKER_SERIAL_DIR || SERIAL_BY_ID_DIR,
  };
}

/** `walker run`: the real service on the Pi. Not yet run on a Pi. Resolves when SIGTERM or SIGINT arrives. */
export async function runOnPi(env: NodeJS.ProcessEnv): Promise<number> {
  const log = createLogger();
  const config = readPiConfig(env);
  const clock = systemClock;
  const bus = new Bus();
  const store = new StateStore(config.stateDir, log);
  const cues = writeCueSounds(join(config.stateDir, "cues"));
  const modules = new ModuleManager({ clock, log, bus });
  const scanner = new SerialScanner({ clock, log, modules, dir: config.serialDir });
  const buttons = new GpioButtons(
    { flavor: config.gpiomon, chip: config.gpioChip, pins: { talk: config.talkPin, confirm: config.confirmPin } },
    { clock, log, bus },
  );
  const speaker = new PiSpeaker(
    // Synthesized replies go to the service's runtime folder in memory (systemd RuntimeDirectory, /run), never the SD
    // card. Run by hand (no RUNTIME_DIRECTORY), a fresh private temp folder stands in, never a shared fixed name.
    {
      playbackDevice: config.playbackDevice,
      piperModel: config.piperModel,
      tmpDir: env.RUNTIME_DIRECTORY ? join(env.RUNTIME_DIRECTORY, "speech") : mkdtempSync(join(tmpdir(), "steady-speech-")),
      cues,
    },
    log,
  );
  attachLogging(bus, log, { replyText: false });
  const service = new WalkerService({
    clock,
    log,
    bus,
    store,
    modules,
    capture: arecordCapture(config.captureDevice, log),
    speaker,
    simulator: false,
    audioInstanceId: "pi-usb-audio",
    makeCloud: (credential) => new HttpCloudClient(credential.server_url, credential.device_id, credential.credential),
  });
  log.info("starting", { mic: config.captureDevice, speaker: speaker.label, gpio: config.gpioChip, state: config.stateDir });
  scanner.start();
  buttons.start();
  service.start();
  const signal = await new Promise<string>((resolve) => {
    process.once("SIGTERM", () => resolve("SIGTERM"));
    process.once("SIGINT", () => resolve("SIGINT"));
  });
  log.info("stopping", { signal });
  service.stop();
  buttons.stop();
  scanner.stop();
  modules.stop();
  return 0;
}
