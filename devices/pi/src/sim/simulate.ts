import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { FileCapture, macMicCapture, resolveMicFiles, type AudioCapture } from "../audio/capture";
import { MacFileSpeaker, MacLoudSpeaker, writeCueSounds, type Speaker } from "../audio/speech";
import { toneWav } from "../audio/wav";
import { Bus } from "../bus";
import { systemClock, withDeadline } from "../clock";
import { HttpCloudClient, pairWithServer } from "../cloud/client";
import { createLogger } from "../log";
import { attachLogging } from "../logging";
import { ModuleManager } from "../serial/modules";
import { WalkerService } from "../service";
import { StateStore } from "../store";
import { FakeCloud, startFakeCloudServer, type FakeCloudServer } from "./fakeCloud";
import { NetworkSwitch, SwitchableCloudClient, type NetworkMode } from "./networkSwitch";
import { SimulatedHand, SimulatedPort, SimulatedTof } from "./fakeModules";
import { SERVICE_VERSION } from "../version";
import { ScriptRunner, parseScript } from "./script";

export interface SimulateOptions {
  /** A real cloud URL; without it the simulator starts the fake cloud on 127.0.0.1. */
  server?: string;
  micFile?: string;
  /** `mac` records the Mac's microphone (asks macOS for permission; records whoever is nearby). */
  mic?: "mac";
  loud: boolean;
  state?: string;
  out?: string;
  script?: string;
}

/** What the fake cloud says on the simulator's demo path, in order. Every line says it is the fake cloud. */
export const FAKE_DEMO_TURNS = [
  { reply: "Fake cloud: this is where Steady's spoken answer goes. The real assistant isn't connected in this run." },
  {
    reply: "Fake cloud: I can switch your alerts from buzzing to short sounds. Press Confirm to do it.",
    proposeCues: ["sound" as const],
  },
  { reply: "Fake cloud: the robot arms aren't on this walker, so I can't pick that up." },
];

const HELP = `Keys: t Talk (press to start, press again to send; a terminal can't see key release)
      c Confirm   n hand in front of the ToF   f nothing in front   i invalid reading
      x ToF stops responding / comes back   o network down / up   g network hangs / up (the walker's own requests)
      r fake cloud forgets this walker (401)   p pair again   ? help   q quit`;

class SilentSpeaker implements Speaker {
  readonly simulated = true;
  readonly label = "silent (no say on this system)";
  speak() {
    return { done: Promise.resolve(), stop() {} };
  }
  playWav() {
    return { done: Promise.resolve(), stop() {} };
  }
  playCue() {
    return Promise.resolve();
  }
}

export async function simulate(options: SimulateOptions): Promise<number> {
  const clock = systemClock;
  const log = createLogger();
  const bus = new Bus();
  const stateDir = options.state ?? mkdtempSync(join(tmpdir(), "steady-sim-"));
  const outDir = options.out ?? join(stateDir, "audio-out");
  const store = new StateStore(stateDir, log);
  log.info("SIMULATOR: every part below is simulated; nothing here is the real walker", { state: stateDir, audio: outDir });

  // ---- Cloud: the fake one, unless a real server is named ----
  let fake: FakeCloud | null = null;
  let fakeServer: FakeCloudServer | null = null;
  // The o and g keys act on the walker's own requests, whichever server it talks to.
  const network = new NetworkSwitch();
  const pairFake = async () => {
    if (!fake || !fakeServer) return;
    const code = fake.issueCode();
    const paired = await withDeadline(clock, 10_000, (signal) =>
      pairWithServer(fakeServer!.url, { code, name: "Simulated walker", service_version: SERVICE_VERSION }, signal),
    );
    store.writeConfiguration(paired.configuration);
    store.writeCredential({ server_url: fakeServer.url, device_id: paired.device_id, credential: paired.credential });
    log.info("paired with the FAKE cloud", { device: paired.device_id });
  };
  if (options.server) {
    if (!store.readCredential()) {
      log.error("no credential in the state folder; run `walker pair <code> --server <url> --state <dir>` first");
      return 2;
    }
  } else {
    fake = new FakeCloud(clock);
    fake.script = FAKE_DEMO_TURNS.map((turn) => ({ ...turn }));
    fakeServer = await startFakeCloudServer(fake, log);
    log.info("FAKE cloud listening (not Steady's assistant: scripted replies only)", { url: fakeServer.url });
    await pairFake();
  }

  // ---- Audio ----
  const cues = writeCueSounds(join(outDir, "cues"));
  let capture: AudioCapture;
  if (options.mic === "mac") {
    log.warn("recording from the Mac microphone: it hears whoever is nearby");
    capture = macMicCapture(log);
  } else if (options.micFile) {
    capture = new FileCapture(resolveMicFiles(options.micFile));
  } else {
    const clip = join(outDir, "sim-clip.wav");
    writeFileSync(clip, toneWav([{ hz: 440, ms: 2000 }]));
    capture = new FileCapture([clip]);
  }
  const speaker: Speaker =
    process.platform !== "darwin" ? new SilentSpeaker() : options.loud ? new MacLoudSpeaker(cues) : new MacFileSpeaker(join(outDir, "speech"));
  log.info("simulated audio", { mic: capture.label, speaker: speaker.label });

  // ---- Simulated modules ----
  const modules = new ModuleManager({ clock, log, bus });
  const handPort = new SimulatedPort("sim:hand-left");
  const tofPort = new SimulatedPort("sim:tof-front");
  const hand = new SimulatedHand(handPort, "hand-left-sim", clock);
  const tof = new SimulatedTof(tofPort, "tof-front-sim", clock);
  hand.onHaptic = (pattern, ms) => log.info("SIMULATED handle buzz", { pattern, ms });
  modules.attach(handPort);
  modules.attach(tofPort);
  hand.start();
  tof.start();

  // ---- Service ----
  const steps = options.script ? parseScript(readFileSync(options.script, "utf8")) : null;
  const runner = steps ? new ScriptRunner(bus) : null;
  // A real cloud's replies can repeat what someone said: log them by length only, as on the Pi.
  attachLogging(bus, log, { replyText: !options.server });
  const service = new WalkerService({
    clock,
    log,
    bus,
    store,
    modules,
    capture,
    speaker,
    simulator: true,
    audioInstanceId: "sim-audio",
    coordinatorInstanceId: "sim-coordinator",
    makeCloud: (credential) =>
      new SwitchableCloudClient(new HttpCloudClient(credential.server_url, credential.device_id, credential.credential), network),
  });
  service.start();

  let finish: (code: number) => void = () => {};
  const finished = new Promise<number>((resolve) => (finish = resolve));

  const press = (key: string) => {
    switch (key) {
      case "t":
        return bus.emit("button", { button: "talk", edge: "pressed", source: "keyboard" });
      case "c":
        return bus.emit("button", { button: "confirm", edge: "pressed", source: "keyboard" });
      case "n":
        tof.readings = { front_left: { mm: 300 }, front_right: { mm: 1500 } };
        return log.info("SIMULATED ToF: hand in front (300 mm, front_left)");
      case "f":
        tof.readings = { front_left: { mm: 1500 }, front_right: { mm: 1500 } };
        return log.info("SIMULATED ToF: nothing in front (1500 mm)");
      case "i":
        tof.readings = { front_left: "invalid", front_right: "invalid" };
        return log.info("SIMULATED ToF: invalid readings");
      case "x":
        if (tof.isRunning) tof.hang();
        else tof.start();
        return log.info(`SIMULATED ToF ${tof.isRunning ? "back" : "stopped responding"}`);
      case "o":
      case "g": {
        const target: NetworkMode = key === "o" ? "down" : "hang";
        network.mode = network.mode === "up" ? target : "up";
        return log.info("SIMULATED network for the walker's requests", { mode: network.mode });
      }
      case "r": {
        const credential = store.readCredential();
        if (fake && credential) fake.forget(credential.device_id);
        return log.info("FAKE cloud forgot this walker");
      }
      case "p":
        void pairFake();
        return;
      case "?":
        return process.stdout.write(`${HELP}\n`);
      case "q":
        return finish(0);
      default:
        return log.warn("unknown key", { key });
    }
  };

  let restoreTty = () => {};
  if (runner && steps) {
    void runner.run(steps, press, (message) => log.info(`SCRIPT ${message}`)).then((failure) => {
      if (failure) log.error(`SCRIPT FAILED ${failure}`);
      else log.info("SCRIPT PASSED: every step happened in order");
      finish(failure ? 1 : 0);
    });
  } else if (process.stdin.isTTY) {
    process.stdout.write(`${HELP}\n`);
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    const onKey = (text: string, key: { ctrl?: boolean; name?: string }) => {
      if (key?.ctrl && key.name === "c") return finish(0);
      if (text) press(text);
    };
    process.stdin.on("keypress", onKey);
    restoreTty = () => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
  } else {
    log.error("no terminal for keys and no --script; nothing to do");
    finish(2);
  }

  const code = await finished;
  restoreTty();
  // Against a real cloud the audio folder holds real replies; it goes unless the person asked for it (--out).
  if (options.server && !options.out) rmSync(outDir, { recursive: true, force: true });
  service.stop();
  hand.hang();
  tof.hang();
  modules.stop();
  await fakeServer?.close();
  if (fake) {
    const device = [...fake.devices.values()][0];
    if (device) {
      log.info("FAKE cloud received", {
        status_events: device.events.length,
        clips: device.clips.length,
        last_clip_bytes: device.clips.at(-1)?.bytes ?? 0,
        configuration_version: device.configurations.at(-1)?.version ?? 0,
      });
    }
  }
  return code;
}
