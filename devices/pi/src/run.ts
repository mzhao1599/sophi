import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arecordCapture } from "./audio/capture";
import { PiSpeaker, writeCueSounds } from "./audio/speech";
import { Bus } from "./bus";
import { startCameraLink } from "./camera";
import { GpioButtons, type GpiomonFlavor } from "./buttons";
import { systemClock } from "./clock";
import { HttpCloudClient } from "./cloud/client";
import { createLogger } from "./log";
import { GpsSampler } from "./gps";
import { attachLogging } from "./logging";
import { ModuleManager } from "./serial/modules";
import { SERIAL_BY_PATH_DIR, SerialScanner } from "./serial/port";
import { localWallTime } from "./screen/machine";
import { defaultScreenAssets, readScreenPort, startWalkerScreen } from "./screen";
import { WalkerService } from "./service";
import { handControlsConnected } from "./motion/handControls";
import { createPiMotion } from "./motion/runtime";
import { isArmPort, readMotionSettings } from "./motion/settings";
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
  /** The installer says Talk and Confirm are wired to the GPIO pins (WALKER_GPIO_BUTTONS=wired). */
  gpioWired: boolean;
  serialDir: string;
}

export const DEFAULT_STATE_DIR = "/var/lib/steady-walker";

/**
 * systemd-timesyncd touches this file each time it has synced the clock (systemd 239 and later). Until it
 * exists the walker screen shows no time, since an unsynced Pi 5 clock can be far off. Not yet checked on our Pi.
 */
export const TIME_SYNCED_FILE = "/run/systemd/timesync/synchronized";

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
  // A typo must not silently leave the buttons unwatched (Talk would do nothing).
  const gpioButtons = env.WALKER_GPIO_BUTTONS ?? "";
  if (gpioButtons !== "" && gpioButtons !== "wired") throw new Error("WALKER_GPIO_BUTTONS must be wired, or left unset when no buttons are wired.");
  return {
    stateDir: env.WALKER_STATE_DIR || DEFAULT_STATE_DIR,
    captureDevice,
    playbackDevice,
    piperModel: env.WALKER_PIPER_MODEL || null,
    gpioChip: env.WALKER_GPIO_CHIP || "gpiochip0",
    talkPin: pin(env.WALKER_GPIO_TALK, 17, "WALKER_GPIO_TALK"),
    confirmPin: pin(env.WALKER_GPIO_CONFIRM, 27, "WALKER_GPIO_CONFIRM"),
    gpiomon,
    gpioWired: gpioButtons === "wired",
    serialDir: env.WALKER_SERIAL_DIR || SERIAL_BY_PATH_DIR,
  };
}

/**
 * `walker run`: the real service on the Pi. Ran on a Pi 5 on 2026-10-23 (paired with the Render server, online,
 * offline and back); its buttons, mic, speaker and serial modules haven't been tried there yet. Resolves when
 * SIGTERM or SIGINT arrives.
 */
export async function runOnPi(env: NodeJS.ProcessEnv): Promise<number> {
  const log = createLogger();
  const config = readPiConfig(env);
  const clock = systemClock;
  const bus = new Bus();
  const store = new StateStore(config.stateDir, log);
  const cues = writeCueSounds(join(config.stateDir, "cues"));
  const modules = new ModuleManager({ clock, log, bus });
  // The arms' Feetech adapters are also under /dev/serial: the ESP32 scanner never opens them (compared by the
  // device each link points to), nor the GPS.
  const scanner = new SerialScanner({ clock, log, modules, dir: config.serialDir, excludedPort: env.WALKER_GPS_PORT, exclude: (path) => isArmPort(path, env) });
  const location = env.WALKER_GPS_PORT
    ? new GpsSampler(env.WALKER_GPS_PORT, Number(env.WALKER_GPS_BAUD || "9600"), (error) => log.warn("GPS read failed", { code: (error as NodeJS.ErrnoException).code ?? error.name }))
    : null;
  // The Pi can't sense a button, so it watches (and reports) the GPIO buttons only when declared wired.
  const buttons = config.gpioWired
    ? new GpioButtons(
        { flavor: config.gpiomon, chip: config.gpioChip, pins: { talk: config.talkPin, confirm: config.confirmPin } },
        { clock, log, bus },
      )
    : null;
  const speaker = new PiSpeaker(
    // Synthesized replies go to the service's runtime folder in memory (systemd RuntimeDirectory, /run), never the SD
    // card. Run by hand (no RUNTIME_DIRECTORY), a fresh private temp folder stands in, never a shared fixed name.
    {
      playbackDevice: config.playbackDevice,
      piperModel: config.piperModel,
      tmpDir: env.RUNTIME_DIRECTORY ? join(env.RUNTIME_DIRECTORY, "speech") : mkdtempSync(join(tmpdir(), "steady-speech-")),
      cues,
      remoteVoice: async (text, signal) => {
        const credential = store.readCredential();
        return credential ? new HttpCloudClient(credential.server_url, credential.device_id, credential.credential).voiceLine(text, signal) : null;
      },
    },
    log,
  );
  attachLogging(bus, log, { replyText: false });
  // Motion (the arms): only when arm ports are configured. A setting that can't be read turns motion off,
  // logged, and never stops the rest of the walker.
  const motionSettings = readMotionSettings(env);
  if (motionSettings.kind === "error") log.error("motion is off: a motion setting can't be read", { reason: motionSettings.reason });
  let announce: (text: string) => void = () => {};
  let proposalOpen: () => boolean = () => false;
  let motion: ReturnType<typeof createPiMotion> | null = null;
  try {
    motion =
      motionSettings.kind === "on"
        ? createPiMotion({
          settings: motionSettings.settings,
          stateDir: config.stateDir,
          runtimeDir: env.RUNTIME_DIRECTORY,
          clock,
          log,
          bus,
          // Before scanner.start() below: the lift board's lines go to the lift client from its first hello.
          modules,
          gpio: { flavor: config.gpiomon, chip: config.gpioChip },
          handControls: () => handControlsConnected(modules, buttons),
          walkerProposalOpen: () => proposalOpen(),
          say: (text) => announce(text),
        })
        : null;
  } catch (error) {
    // A motion folder or port problem turns motion off; the rest of the walker keeps running.
    log.error("motion is off: it couldn't start", { error: (error as Error).message });
    motion = null;
  }
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
    coordinatorInstanceId: "pi-coordinator",
    ...(location ? { location } : {}),
    ...(buttons ? { gpioButtons: buttons } : {}),
    ...(motion ? { motion: motion.coordinator } : {}),
    makeCloud: (credential) => new HttpCloudClient(credential.server_url, credential.device_id, credential.credential),
  });
  announce = (text) => service.announce(text);
  proposalOpen = () => service.hasOpenProposal();
  // Report the buttons the moment they count as watched, not at the next 5 s tick.
  if (buttons) buttons.onWatching = () => service.reportSoon();
  log.info("starting", {
    mic: config.captureDevice,
    speaker: speaker.label,
    gpio: buttons ? config.gpioChip : "not declared wired (WALKER_GPIO_BUTTONS)",
    state: config.stateDir,
  });
  const stopSignal = new Promise<string>((resolve) => {
    process.once("SIGTERM", () => resolve("SIGTERM"));
    process.once("SIGINT", () => resolve("SIGINT"));
  });
  scanner.start();
  buttons?.start();
  service.start();
  if (motion) {
    // An error nothing caught, anywhere in the service, stops motion (and is logged); the service keeps running.
    const running = motion;
    process.on("unhandledRejection", (reason) => {
      log.error("unhandled error; stopping motion", { error: reason instanceof Error ? reason.message : String(reason) });
      running.coordinator.emergencyStop("unhandled error");
    });
    void motion.coordinator.start().catch((error: unknown) => log.error("motion coordinator failed to start", { error: (error as Error).message }));
    void motion.socket.listen().catch((error: unknown) => log.error("operator socket failed to start", { error: (error as Error).message }));
  }
  // The screen never holds up or takes down the walker: startWalkerScreen logs a failure and returns.
  const screenPort = readScreenPort(env.WALKER_SCREEN_PORT);
  const screen =
    "port" in screenPort
      ? await startWalkerScreen({
          bus,
          clock,
          log,
          service,
          modules,
          simulator: false,
          port: screenPort.port,
          assetsDir: env.WALKER_SCREEN_ASSETS || defaultScreenAssets(),
          localTime: () => (existsSync(TIME_SYNCED_FILE) ? localWallTime(clock.now()) : null),
          greeting: env.WALKER_SCREEN_GREETING,
        })
      : null;
  if ("off" in screenPort) log.info("walker screen off", { reason: screenPort.off });
  // The live camera, only with WALKER_CAMERA_DEVICE set; its failures are logged and never stop the walker.
  const camera = startCameraLink({ env, clock, log, store });
  const signal = await stopSignal;
  log.info("stopping", { signal });
  await camera?.stop();
  motion?.socket.close();
  await motion?.coordinator.stop();
  service.stop();
  await screen?.stop();
  buttons?.stop();
  scanner.stop();
  modules.stop();
  return 0;
}
