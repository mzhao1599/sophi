import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { FileCapture, macMicCapture, resolveMicFiles, type AudioCapture } from "../audio/capture";
import { MacFileSpeaker, MacLoudSpeaker, writeCueSounds, type Speaker } from "../audio/speech";
import { toneWav } from "../audio/wav";
import { Bus } from "../bus";
import { startCamera } from "../camera";
import { systemClock, withDeadline } from "../clock";
import { HttpCloudClient, pairWithServer } from "../cloud/client";
import { createLogger } from "../log";
import { attachLogging } from "../logging";
import { ModuleManager } from "../serial/modules";
import { defaultScreenAssets, readScreenPort, startWalkerScreen, type WalkerScreen } from "../screen";
import { localWallTime } from "../screen/machine";
import { WalkerService } from "../service";
import { StateStore } from "../store";
import { FakeCloud, startFakeCloudServer, type FakeCloudServer } from "./fakeCloud";
import { SIMULATED_LOOKUPS } from "./fakeGps";
import { ShowViewSchema } from "@walker/contracts";
import { NetworkSwitch, SwitchableCloudClient, type NetworkMode } from "./networkSwitch";
import { SimulatedHand, SimulatedPort, SimulatedTof } from "./fakeModules";
import { SERVICE_VERSION } from "../version";
import { HELP_HOLD_MS } from "@walker/contracts";
import { ScriptRunner, parseScript, type CommandStep } from "./script";
import { SimulatedPosition, readWalkSpeedup } from "../navigation/simulated";
import { mapServicesFromEnv } from "../navigation/osm";
import { recordedMapServices } from "./fakeMaps";
import { LIFT_HELP, LIFT_KEYS, LiftSim, liftSimBench } from "./liftSim";
import { MOTION_HELP, MOTION_KEYS, MotionSim, type MotionSimHand } from "./motionSim";
import { handControlsConnected } from "../motion/handControls";
import { OperatorSocket } from "../motion/operator";
import { readBench } from "../motion/settings";

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
  /** Also serve the walker screen's page on 127.0.0.1 (WALKER_SCREEN_PORT, default 8740) and print its address. */
  screen?: boolean;
  /**
   * SIMULATED weather and address samples (no internet), for location questions and `show_on_screen`. The
   * position itself is always the SIMULATED one that walks routes (see "SIMULATED position and map services").
   */
  gps?: boolean;
  /** A SIMULATED lift board, driven by the real lift client under the real motion coordinator (turns on `arms`). */
  lift?: boolean;
  /** SIMULATED arms: fake servo buses through the real motion coordinator, and a simulated stop switch. */
  arms?: boolean;
  /**
   * The live camera, as WALKER_CAMERA_DEVICE: `test-pattern` (ffmpeg's generated picture, labelled so on the
   * phone) or a /dev video path. Needs --server: the fake cloud has no camera routes.
   */
  camera?: string;
}

/** What the fake cloud says on the simulator's demo path, in order. Every line says it is the fake cloud. */
export const FAKE_DEMO_TURNS = [
  { reply: "Fake cloud: this is where Sophi's spoken answer goes. The real assistant isn't connected in this run." },
  {
    reply: "Fake cloud: I can switch your alerts from buzzing to short sounds. Press Confirm to do it.",
    proposeCues: ["sound" as const],
  },
  { reply: "Fake cloud: the robot arms aren't on this walker, so I can't pick that up." },
];

/** Runs a script's `gps ...` and `fake ...` steps against the simulated position and the fake cloud. */
export function scriptCommand(fake: FakeCloud | null, position: SimulatedPosition): (step: CommandStep) => void {
  return (step) => {
    if (step.kind === "fake") {
      if (!fake) throw new Error("fake steps need the fake cloud (no --server)");
      fake.script.push(step.tool ? { reply: step.reply, tool: step.tool } : { reply: step.reply });
      return;
    }
    const [a = 0, b = 0] = step.numbers;
    if (step.action === "at") position.at(a, b);
    else if (step.action === "walk") position.walk(a);
    else if (step.action === "off_route") position.offRoute(a);
    else if (step.action === "pause") position.pause();
    else position.resume();
  };
}

const HELP = `Keys: t Talk (press to start, press again to send; a terminal can't see key release)
      c Confirm   n hand in front of the ToF   f nothing in front   i invalid reading
      x ToF stops responding / comes back   o network down / up   g network hangs / up (the walker's own requests)
      m a fake caretaker ("Maya") sends a message (fake cloud only)
      h both handle buttons held 2.5 s (asking for help)   + the fake cloud's next turn asks for help by voice
      , Maya's (fake) phone shows the request   . Maya: "I'm on my way"   / Maya: "I'm with Rose"   ; Rose's phone asks
      a script's "key show-weather" (or show-location, show-sensors, show-message, show-parts): the next
        Talk turn asks to show that view on the screen (fake cloud only)
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
  const steps = options.script ? parseScript(readFileSync(options.script, "utf8")) : null;

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
    // A script that scripts the fake cloud itself (`fake ...` steps) starts with none of the demo's answers.
    fake.script = steps?.some((step) => step.kind === "fake") ? [] : FAKE_DEMO_TURNS.map((turn) => ({ ...turn }));
    // WALKER_FAKE_TURN_MS: how long the fake cloud takes to answer a turn (0 unless set; at most 10 s).
    const turnDelay = Math.min(10_000, Math.max(0, Number(process.env.WALKER_FAKE_TURN_MS) || 0));
    fakeServer = await startFakeCloudServer(fake, log, turnDelay);
    log.info("FAKE cloud listening (not Sophi's assistant: scripted replies only)", { url: fakeServer.url });
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
  let handPort = new SimulatedPort("sim:hand-right");
  const tofPort = new SimulatedPort("sim:tof-front");
  let hand = new SimulatedHand(handPort, "hand-right-sim", clock);
  const tof = new SimulatedTof(tofPort, "tof-front-sim", clock);
  hand.onHaptic = (pattern, ms) => log.info("SIMULATED handle buzz", { pattern, ms });
  modules.attach(handPort);
  modules.attach(tofPort);
  hand.start();
  tof.start();
  // ---- SIMULATED lift (--lift): a simulated lift board, its real client under the motion coordinator ----
  const lift = options.lift ? new LiftSim({ clock, log, bus, modules, bench: liftSimBench(process.env) }) : null;
  if (lift && !options.arms) log.info("--lift turns on --arms: the lift runs under the motion coordinator, with the arms");

  // ---- SIMULATED arms (--arms): fake servo buses through the real motion coordinator ----
  let announce: (text: string) => void = () => {};
  let proposalOpen: () => boolean = () => false;
  let motion: { sim: MotionSim; socket: OperatorSocket; actions: Record<string, () => void> } | null = null;
  if (options.arms || lift) {
    const bench = readBench(process.env);
    if (!bench.ok) {
      log.error(bench.reason);
      return 2;
    }
    const handControl: MotionSimHand = {
      get plugged() {
        return hand.isRunning;
      },
      unplug() {
        hand.hang();
        handPort.unplug();
        log.info("SIMULATED handle unplugged");
      },
      plug() {
        handPort = new SimulatedPort("sim:hand-right");
        hand = new SimulatedHand(handPort, "hand-right-sim", clock);
        hand.onHaptic = (pattern, ms) => log.info("SIMULATED handle buzz", { pattern, ms });
        modules.attach(handPort);
        hand.start();
        log.info("SIMULATED handle plugged in");
      },
    };
    const sim = new MotionSim({
      clock,
      log,
      bus,
      stateDir,
      bench: bench.bench,
      hand: handControl,
      handControls: () => handControlsConnected(modules, null),
      walkerProposalOpen: () => proposalOpen(),
      say: (text) => announce(text),
      ...(lift ? { lift } : {}),
    });
    const actions = sim.actions();
    // The lift's keys prepare its targets with the real coordinator, as the terminal does; `y` is the one stop switch.
    if (lift) Object.assign(actions, lift.actions(sim.coordinator, () => actions["stop-switch"]!()));
    motion = { sim, socket: new OperatorSocket(join(stateDir, "motion.sock"), sim.coordinator, log), actions };
  }

  // ---- SIMULATED position and map services ----
  // The position always is simulated here. Against a real server the map services are the real public ones: a
  // recorded route must never reach a real assistant as if it were planned live. With the fake cloud they are the
  // recorded responses (offline, repeatable). WALKER_SIM_MAPS=live or recorded overrides (recorded against a real
  // server is for tests only).
  let speedup: number;
  try {
    speedup = readWalkSpeedup(process.env.WALKER_SIM_WALK_SPEEDUP);
  } catch (error) {
    log.error((error as Error).message);
    return 2;
  }
  const position = new SimulatedPosition(clock, log, { speedup });
  const mapsChoice = process.env.WALKER_SIM_MAPS;
  if (mapsChoice !== undefined && mapsChoice !== "" && mapsChoice !== "live" && mapsChoice !== "recorded") {
    log.error("WALKER_SIM_MAPS must be live or recorded.");
    return 2;
  }
  const liveMaps = mapsChoice === "live" || (mapsChoice !== "recorded" && Boolean(options.server));
  const maps = liveMaps ? mapServicesFromEnv(process.env, clock) : recordedMapServices(clock);
  log.info("SIMULATED GPS position by Lake Merritt, Oakland", {
    walk_speedup: speedup,
    maps: liveMaps ? "live OpenStreetMap services" : "recorded responses (only the Lake Merritt Boating Center route)",
  });

  // ---- Service ----
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
    ...(motion ? { motion: motion.sim.coordinator } : {}),
    location: position,
    maps,
    // `--gps`: the labelled sample weather and address instead of the map services (no internet).
    ...(options.gps ? { lookups: SIMULATED_LOOKUPS } : {}),
  });
  if (options.gps) log.info("SIMULATED weather and address: samples that say they are simulated (no internet)");
  announce = (text) => service.announce(text);
  proposalOpen = () => service.hasOpenProposal();
  service.start();
  if (options.camera && !options.server) log.error("--camera needs --server: the fake cloud has no camera routes; the camera stays off");
  const camera = options.camera && options.server ? await startCamera({ env: { ...process.env, WALKER_CAMERA_DEVICE: options.camera }, clock, log, store, onFall: () => service.fallSeen() }) : null;
  if (motion) {
    const started = motion.sim.coordinator.start();
    // After the script runner and the coordinator's listeners exist, so both see the lift's first lines.
    lift?.start();
    await started;
    // A Unix socket path over about 104 bytes (macOS) can't be opened: the arms still run, without the terminal.
    await motion.socket.listen().catch((error: unknown) =>
      log.error("the terminal's socket couldn't open (a shorter --state path helps)", { error: (error as Error).message }),
    );
    log.info("SIMULATED arms ready; the terminal commands work against them", { socket: join(stateDir, "motion.sock") });
  }

  let screen: WalkerScreen | null = null;
  if (options.screen) {
    const screenPort = readScreenPort(process.env.WALKER_SCREEN_PORT);
    if ("off" in screenPort) log.warn("walker screen off", { reason: screenPort.off });
    else {
      screen = await startWalkerScreen({
        bus,
        clock,
        log,
        service,
        modules,
        simulator: true,
        port: screenPort.port,
        assetsDir: process.env.WALKER_SCREEN_ASSETS || defaultScreenAssets(),
        localTime: () => localWallTime(clock.now()),
        greeting: process.env.WALKER_SCREEN_GREETING,
        logDrawn: true,
      });
      if (screen.url) process.stdout.write(`Walker screen (simulator): ${screen.url}  (open it at 800x480)
`);
    }
  }

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
      case "m": {
        const credential = store.readCredential();
        if (!fake || !credential) return log.warn("the m key needs the fake cloud and a paired walker");
        fake.sendFromCaretaker(credential.device_id, "Maya", "Dinner at six. I'll get you.");
        return log.info("FAKE caretaker Maya sent a message (sample words, no real phone)");
      }
      // Asking for help. The chord goes through the simulated hand board, the real ESP32 path: both down, then up.
      case "chord-down":
        hand.press("talk", "pressed");
        hand.press("confirm", "pressed");
        return log.info("SIMULATED handle: Talk and Confirm down");
      case "chord-up":
        hand.press("talk", "released");
        hand.press("confirm", "released");
        return log.info("SIMULATED handle: Talk and Confirm up");
      case "h":
        press("chord-down");
        setTimeout(() => press("chord-up"), HELP_HOLD_MS + 500);
        return;
      case "+":
      case "help-next-turn":
        if (!fake) return log.warn("the + key needs the fake cloud");
        fake.script.unshift({ reply: "Fake cloud: asking for help.", askForHelp: true });
        return log.info("FAKE cloud: the next turn answers as a voice request for help");
      case ",":
      case "help-shown":
      case ".":
      case "help-coming":
      case "/":
      case "help-with-her":
      case ";":
      case "help-phone": {
        const credential = store.readCredential();
        if (!fake || !credential) return log.warn("the help keys need the fake cloud and a paired walker");
        try {
          if (key === "," || key === "help-shown") fake.helpShownOn(credential.device_id, "Maya");
          else if (key === "." || key === "help-coming") fake.helpComing(credential.device_id, "Maya");
          else if (key === "/" || key === "help-with-her") fake.helpWithHer(credential.device_id, "Maya");
          else fake.helpFromPhone(credential.device_id);
          return log.info("FAKE caretaker phone (made up, no real phone)", { action: key });
        } catch (error) {
          return log.warn("fake help action not done", { error: (error as Error).message });
        }
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
        return process.stdout.write(`${HELP}\n${lift ? `${LIFT_HELP}\n` : ""}${motion ? `${MOTION_HELP}\n` : ""}`);
      case "q":
        return finish(0);
      default: {
        const show = /^show-(.+)$/.exec(key)?.[1];
        const view = show ? ShowViewSchema.safeParse(show) : null;
        if (view?.success) {
          if (!fake) return log.warn("the show keys need the fake cloud");
          fake.queueShow(view.data);
          return log.info("FAKE cloud: the next Talk turn asks to show this on the screen", { view: view.data });
        }
        // Lift and arms: a script names the action ("key lift-home", "key torque-on-left"); the keyboard uses
        // LIFT_KEYS and MOTION_KEYS.
        const action = motion?.actions[key] ?? motion?.actions[LIFT_KEYS[key] ?? ""] ?? motion?.actions[MOTION_KEYS[key] ?? ""];
        if (action) return action();
        return log.warn("unknown key", { key });
      }
    }
  };

  const command = scriptCommand(fake, position);

  let restoreTty = () => {};
  if (runner && steps) {
    void runner.run(steps, press, (message) => log.info(`SCRIPT ${message}`), undefined, command).then((failure) => {
      if (failure) log.error(`SCRIPT FAILED ${failure}`);
      else log.info("SCRIPT PASSED: every step happened in order");
      finish(failure ? 1 : 0);
    });
  } else if (process.stdin.isTTY) {
    process.stdout.write(`${HELP}\n${lift ? `${LIFT_HELP}\n` : ""}${motion ? `${MOTION_HELP}\n` : ""}`);
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
  await camera?.stop();
  motion?.socket.close();
  await motion?.sim.stop();
  lift?.stop();
  service.stop();
  await screen?.stop();
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
