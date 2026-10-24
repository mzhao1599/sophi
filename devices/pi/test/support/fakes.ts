import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioCapture, CaptureSession, Clip } from "../../src/audio/capture";
import type { Speaker, Utterance } from "../../src/audio/speech";
import { wavFromPcm } from "../../src/audio/wav";
import { Bus, type BusEvents, type ButtonName, type ButtonSourceKind, type CueName, type Edge } from "../../src/bus";
import type { Cancel, Clock } from "../../src/clock";
import { CLIP_BYTES_PER_MS, CLIP_MAX_PCM_BYTES } from "../../src/constants";
import type { Logger } from "../../src/log";
import { formatFields } from "../../src/log";
import { ModuleManager } from "../../src/serial/modules";
import { WalkerService } from "../../src/service";
import type { Cue } from "@walker/contracts";
import { FakeCloud, FakeCloudClient } from "../../src/sim/fakeCloud";
import { SimulatedHand, SimulatedPort, SimulatedTof } from "../../src/sim/fakeModules";
import { StateStore } from "../../src/store";

/** Lets every pending promise and I/O callback run, without letting any time pass on the fake clock. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A clock that only moves when a test says so. Wall time moves with monotonic time. */
export class FakeClock implements Clock {
  private mono = 0;
  private readonly wallStart = Date.parse("2026-10-24T12:00:00.000Z");
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  private nextId = 0;

  now(): number {
    return this.wallStart + this.mono;
  }

  monotonic(): number {
    return this.mono;
  }

  setTimeout(fn: () => void, ms: number): Cancel {
    const timer = { id: this.nextId++, at: this.mono + Math.max(0, ms), fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  /** Moves time forward, firing every timer due on the way in order, letting promises settle after each. */
  async advance(ms: number): Promise<void> {
    const target = this.mono + ms;
    for (;;) {
      await flush();
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.mono = due.at;
      due.fn();
    }
    this.mono = target;
    await flush();
  }
}

export class FakeCapture implements AudioCapture {
  readonly simulated = true;
  readonly label = "fake mic";
  starts = 0;
  aborts = 0;
  failNextStop = false;
  /** Every clip handed out, so tests can check it was zeroed after sending. */
  clips: Clip[] = [];

  constructor(private readonly clock: FakeClock) {}

  start(): CaptureSession {
    this.starts += 1;
    const startedAt = this.clock.monotonic();
    return {
      stop: async () => {
        if (this.failNextStop) {
          this.failNextStop = false;
          throw new Error("fake mic failed");
        }
        const ms = this.clock.monotonic() - startedAt;
        const pcm = Buffer.alloc(Math.min(CLIP_MAX_PCM_BYTES, Math.round(ms * CLIP_BYTES_PER_MS)), 0x11);
        const clip = { wav: wavFromPcm(pcm, 16000), durationMs: Math.floor(pcm.length / CLIP_BYTES_PER_MS) };
        this.clips.push(clip);
        return clip;
      },
      abort: () => {
        this.aborts += 1;
      },
    };
  }
}

export class FakeSpeaker implements Speaker {
  readonly simulated = true;
  readonly label = "fake speaker";
  /** When true, each utterance plays until `finish()`; otherwise it ends at once. */
  hold = false;
  /** When true, playing the server's WAV fails (the walker should then speak the text itself). */
  failWav = false;
  /** When true, `stop()` is recorded but the utterance keeps "playing", like a player that ignores signals. */
  ignoreStop = false;
  spoken: string[] = [];
  /** Server-voiced replies played, by byte length. */
  played: number[] = [];
  stopped: string[] = [];
  cues: CueName[] = [];
  private playing: Array<{ text: string; end: () => void }> = [];

  private utterance(label: string): Utterance {
    let end: () => void = () => {};
    const done = new Promise<void>((resolve) => (end = resolve));
    if (!this.hold) end();
    else this.playing.push({ text: label, end });
    return {
      done,
      stop: () => {
        this.stopped.push(label);
        if (!this.ignoreStop) end();
      },
    };
  }

  speak(text: string): Utterance {
    this.spoken.push(text);
    return this.utterance(text);
  }

  playWav(wav: Buffer): Utterance {
    if (this.failWav) return { done: Promise.reject(new Error("fake playback failed")), stop() {} };
    this.played.push(wav.length);
    return this.utterance(`wav:${wav.length}`);
  }

  finish(): void {
    for (const item of this.playing.splice(0)) item.end();
  }

  /** Cues named here never finish playing, like a hung player. */
  hangCues = new Set<CueName>();

  playCue(name: CueName): Promise<void> {
    this.cues.push(name);
    return this.hangCues.has(name) ? new Promise(() => {}) : Promise.resolve();
  }
}

export function captureLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const at = (level: string) => (message: string, fields?: Parameters<typeof formatFields>[0]) =>
    lines.push(`${level} ${message}${formatFields(fields)}`);
  return { lines, info: at("info"), warn: at("warn"), error: at("error") };
}

type Recorded = { [K in keyof BusEvents]: { name: K; payload: BusEvents[K] } }[keyof BusEvents];

export interface HarnessOptions {
  paired?: boolean;
  cues?: Cue[];
  withHand?: boolean;
  withTof?: boolean;
}

/** One walker service on fakes: fake clock, fake mic and speaker, simulated modules and the fake cloud. */
export function makeHarness(options: HarnessOptions = {}) {
  const clock = new FakeClock();
  const bus = new Bus();
  const log = captureLogger();
  const dir = mkdtempSync(join(tmpdir(), "walker-pi-test-"));
  const store = new StateStore(dir, log);
  const fake = new FakeCloud(clock, options.cues ?? ["vibration", "spoken"]);
  let credential = "";
  if (options.paired !== false) credential = pairInto(fake, store).credential;
  const clients: FakeCloudClient[] = [];
  const modules = new ModuleManager({ clock, log, bus });
  const capture = new FakeCapture(clock);
  const speaker = new FakeSpeaker();
  const events: Recorded[] = [];
  for (const name of ["spoke", "cue", "haptic", "talk", "link", "config", "heartbeat", "turn", "button"] as const) {
    bus.on(name, (payload) => events.push({ name, payload } as Recorded));
  }
  let ids = 0;
  const service = new WalkerService({
    clock,
    log,
    bus,
    store,
    modules,
    capture,
    speaker,
    simulator: true,
    audioInstanceId: "test-audio",
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    makeCloud: (file) => {
      const client = new FakeCloudClient(fake, file.device_id, file.credential);
      clients.push(client);
      return client;
    },
  });

  let hand: SimulatedHand | null = null;
  let tof: SimulatedTof | null = null;
  if (options.withHand) {
    const port = new SimulatedPort("sim:hand");
    hand = new SimulatedHand(port, "hand-left-01", clock);
    modules.attach(port);
    hand.start();
  }
  if (options.withTof) {
    const port = new SimulatedPort("sim:tof");
    tof = new SimulatedTof(port, "tof-front-01", clock);
    modules.attach(port);
    tof.start();
  }

  return {
    clock,
    bus,
    log,
    dir,
    store,
    fake,
    credential,
    modules,
    capture,
    speaker,
    service,
    events,
    hand,
    tof,
    /** The newest cloud client (a new one is made whenever the credential changes). */
    get client(): FakeCloudClient {
      const client = clients.at(-1);
      if (!client) throw new Error("No cloud client yet.");
      return client;
    },
    spoken: (kind?: BusEvents["spoke"]["kind"]) =>
      events.filter((e) => e.name === "spoke" && (!kind || e.payload.kind === kind)).map((e) => (e.payload as BusEvents["spoke"]).text),
    named: <K extends keyof BusEvents>(name: K) =>
      events.filter((e) => e.name === name).map((e) => e.payload as BusEvents[K]),
    press: (button: ButtonName, edge: Edge = "pressed", source: ButtonSourceKind = "gpio") =>
      bus.emit("button", { button, edge, source }),
    device: () => [...fake.devices.values()].at(-1),
  };
}

export type Harness = ReturnType<typeof makeHarness>;

/** Pairs with the fake cloud the way `walker pair` does: configuration 1, then the credential. */
export function pairInto(fake: FakeCloud, store: StateStore) {
  const paired = fake.pair({ code: fake.issueCode(), service_version: "test" });
  store.writeConfiguration(paired.configuration);
  store.writeCredential({ server_url: "https://walker.example.test", device_id: paired.device_id, credential: paired.credential });
  return paired;
}

/** Boots the harness and lets the first heartbeat land. */
export async function boot(harness: Harness): Promise<void> {
  harness.service.start();
  await harness.clock.advance(0);
  await flush();
}
