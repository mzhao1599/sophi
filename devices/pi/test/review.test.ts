import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CapabilityManifestSchema } from "@walker/contracts";
import { describe, expect, it } from "vitest";
import { PiSpeaker } from "../src/audio/speech";
import { Bus } from "../src/bus";
import { GpioButtons } from "../src/buttons";
import { CuePolicy } from "../src/cues";
import { LINES } from "../src/notices";
import { sttyArgs } from "../src/serial/port";
import { SimulatedPort } from "../src/sim/fakeModules";
import { StateStore } from "../src/store";
import { SERVICE_VERSION } from "../src/version";
import { FakeClock, boot, captureLogger, flush, makeHarness, type Harness } from "./support/fakes";

/** Rows added from the break-it review (test/EXPECTED.md, marked "review"). */

async function talk(h: Harness, ms = 2000): Promise<void> {
  h.press("talk", "pressed");
  await h.clock.advance(ms);
  h.press("talk", "released");
  await flush();
}

describe("B18: a late heartbeat answer never overrides newer knowledge of the proposal", () => {
  it("a heartbeat that left before the turn opened a proposal doesn't erase it", async () => {
    const h = makeHarness();
    await boot(h);
    h.fake.script = [{ reply: "Fake cloud: switch?", proposeCues: ["sound"] }];
    h.press("talk", "pressed");
    await h.clock.advance(4000);
    h.client.late.add("heartbeat");
    await h.clock.advance(1000); // the 5 s heartbeat is answered now (no proposal yet) but arrives later
    h.client.late.delete("heartbeat");
    h.press("talk", "released");
    await flush();
    expect(h.service.openProposal).not.toBeNull();
    h.client.releaseHeld();
    await flush();
    expect(h.service.openProposal).not.toBeNull();
    h.press("confirm");
    await flush();
    expect(h.spoken("confirm_result")).toEqual(["Done. Obstacle alerts now use short sounds."]);
  });

  it("a heartbeat that left before Confirm closed the proposal doesn't reopen it", async () => {
    const h = makeHarness();
    await boot(h);
    h.fake.script = [{ reply: "Fake cloud: switch?", proposeCues: ["sound"] }];
    await talk(h);
    h.client.late.add("heartbeat");
    await h.clock.advance(5000); // answered with the proposal still open, delivered later
    h.client.late.delete("heartbeat");
    h.press("confirm");
    await flush();
    expect(h.service.openProposal).toBeNull();
    h.client.releaseHeld();
    await flush();
    expect(h.service.openProposal).toBeNull();
    h.press("confirm");
    await flush();
    expect(h.client.calls.filter((c) => c === "answer:confirm")).toHaveLength(1);
    expect(h.speaker.cues.at(-1)).toBe("nothing_to_confirm");
  });
});

describe("B19: a recording whose button can't report its release is discarded", () => {
  it("the hand module that started it unplugs", async () => {
    const h = makeHarness({ withHand: true });
    await boot(h);
    h.hand!.press("talk", "pressed");
    await h.clock.advance(1000);
    expect(h.service.talk).toBe("recording");
    h.hand!.port.unplug();
    await flush();
    expect(h.service.talk).toBe("idle");
    expect(h.capture.aborts).toBe(1);
    expect(h.client.calls).not.toContain("turn");
    expect(h.spoken("local_reply")).toEqual([LINES.stoppedListening]);
  });

  it("the hand module that started it reboots (a new hello)", async () => {
    const h = makeHarness({ withHand: true });
    await boot(h);
    h.hand!.press("talk", "pressed");
    await h.clock.advance(1000);
    h.hand!.start();
    await flush();
    expect(h.service.talk).toBe("idle");
    expect(h.client.calls).not.toContain("turn");
  });

  it("another source's loss leaves the recording alone", async () => {
    const h = makeHarness({ withHand: true });
    await boot(h);
    h.press("talk", "pressed", "gpio");
    await h.clock.advance(1000);
    h.hand!.port.unplug();
    await flush();
    expect(h.service.talk).toBe("recording");
  });

  it("gpiomon exits: GPIO recordings are dropped, and the next real press works", async () => {
    const h = makeHarness();
    await boot(h);
    const children: EventEmitter[] = [];
    const spawnChild = (() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 77,
        exitCode: null,
        signalCode: null,
        kill: () => true,
      });
      children.push(child);
      return child;
    }) as never;
    const buttons = new GpioButtons({ flavor: "v1", chip: "gpiochip0", pins: { talk: 17, confirm: 27 } }, { clock: h.clock, log: h.log, bus: h.bus, spawnChild });
    buttons.start();
    buttons.handleLine("17 0");
    await h.clock.advance(1000);
    expect(h.service.talk).toBe("recording");
    children[0]!.emit("close", 1);
    await flush();
    expect(h.service.talk).toBe("idle");
    expect(h.client.calls).not.toContain("turn");
    await h.clock.advance(5000); // gpiomon restarts
    expect(children).toHaveLength(2);
    buttons.handleLine("17 0");
    await h.clock.advance(1000);
    expect(h.service.talk).toBe("recording");
    buttons.stop();
  });
});

it("B20: a hung listening cue delays the mic by at most 1 s", async () => {
  const h = makeHarness();
  await boot(h);
  h.speaker.hangCues.add("listening");
  h.press("talk", "pressed");
  await h.clock.advance(999);
  expect(h.capture.starts).toBe(0);
  await h.clock.advance(1);
  expect(h.capture.starts).toBe(1);
});

describe("S12: serial writes", () => {
  it("a busy port drops the haptic instead of queueing it, and the seq doesn't skip", async () => {
    const h = makeHarness({ withHand: true });
    await boot(h);
    h.hand!.port.busy = true;
    expect(h.modules.sendHaptic("hand-right-01", "near_obstacle", 400)).toBe(false);
    h.hand!.port.busy = false;
    expect(h.modules.sendHaptic("hand-right-01", "near_obstacle", 400)).toBe(true);
    // seq 0 was the hello.request sent on opening; the dropped haptic took no number.
    expect(h.hand!.port.received.map((line) => [JSON.parse(line).type, JSON.parse(line).seq])).toEqual([
      ["hello.request", 0],
      ["haptic.play", 1],
    ]);
  });

  it("stty sets clocal on Linux and macOS", () => {
    expect(sttyArgs("/dev/serial/by-id/x", "linux")).toEqual(["-F", "/dev/serial/by-id/x", "115200", "raw", "-echo", "clocal"]);
    expect(sttyArgs("/dev/ttys001", "darwin")[0]).toBe("-f");
  });
});

it("C12: a zone flickering between near and invalid cues every 3 s, not every second", async () => {
  const clock = new FakeClock();
  let sounds = 0;
  const at: number[] = [];
  const policy = new CuePolicy({
    clock,
    log: captureLogger(),
    modules: { hapticTargets: () => [], sendHaptic: () => true },
    playObstacleSound: () => {
      sounds += 1;
      at.push(clock.monotonic());
    },
    cues: () => ["sound"],
  });
  for (let t = 0; t < 10_000; t += 100) {
    const near = (t / 100) % 2 === 0;
    policy.evaluate([
      {
        zone: "front_left",
        instanceId: "tof-front-01",
        mm: near ? 300 : null,
        quality: near ? "valid" : "invalid",
        receivedMono: clock.monotonic(),
        receivedWall: clock.now(),
      },
    ]);
    await clock.advance(100);
  }
  expect(at).toEqual([0, 3000, 6000, 9000]);
  expect(sounds).toBe(4);
});

it("W5: the Pi speaker empties its private temp folder at startup", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "walker-speech-")), "steady-speech");
  mkdirSync(dir);
  writeFileSync(join(dir, "speech-3.wav"), "left over from a crash");
  new PiSpeaker({ playbackDevice: "default", piperModel: null, tmpDir: dir, cues: {} as never }, captureLogger());
  expect(existsSync(join(dir, "speech-3.wav"))).toBe(false);
  expect(existsSync(dir)).toBe(true);
});

describe("P7: a credential the walker can't use", () => {
  it("a non-https server reads as unpaired and the service keeps running", async () => {
    const h = makeHarness({ paired: false });
    writeFileSync(
      join(h.dir, "credential.json"),
      JSON.stringify({ server_url: "http://walker.example.test", device_id: "55555555-5555-4555-8555-555555555555", credential: "c".repeat(43) }),
      { mode: 0o600 },
    );
    await boot(h);
    expect(h.service.link).toBe("unpaired");
    h.press("talk");
    await flush();
    expect(h.spoken("local_reply")).toEqual([LINES.notPaired]);
    expect(h.log.lines.some((line) => line.includes("credential file is unreadable"))).toBe(true);
  });

  it("an unreadable file (permissions) is logged with its reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "walker-state-"));
    const log = captureLogger();
    const store = new StateStore(dir, log);
    store.writeCredential({ server_url: "https://walker.example.test", device_id: "55555555-5555-4555-8555-555555555555", credential: "c".repeat(43) });
    chmodSync(join(dir, "credential.json"), 0o000);
    expect(store.readCredential()).toBeNull();
    expect(log.lines.join("\n")).toMatch(/can't be read.*EACCES/);
    chmodSync(join(dir, "credential.json"), 0o600);
  });
});

it("P8: a configuration that can't be saved still applies", async () => {
  const h = makeHarness();
  await boot(h);
  h.fake.script = [{ reply: "Fake cloud: switch?", proposeCues: ["sound"] }];
  await talk(h);
  h.store.writeConfiguration = () => {
    throw new Error("read-only file system");
  };
  h.press("confirm");
  await flush();
  expect(h.service.configuration).toMatchObject({ version: 2, cues: ["sound"] });
  expect(h.spoken("confirm_result")).toEqual(["Done. Obstacle alerts now use short sounds."]);
  expect(h.log.lines.some((line) => line.includes("couldn't save the configuration"))).toBe(true);
});

/** Rows added from the second break-it pass (test/EXPECTED.md, marked "review 2"). */
describe("second review", () => {
  const zone = (clock: FakeClock, mm: number | null) => ({
    zone: "front_left",
    instanceId: "tof-front-01",
    mm,
    quality: (mm === null ? "invalid" : "valid") as "valid" | "invalid",
    receivedMono: clock.monotonic(),
    receivedWall: clock.now(),
  });

  function soundPolicy(clock: FakeClock, sent: boolean, cues: ("vibration" | "sound")[] = ["sound"]) {
    const at: number[] = [];
    const hand = {
      instanceId: "hand-right-01",
      type: "hand" as const,
      catalogId: "controls.hand" as const,
      capabilities: ["haptic"],
      firmwareVersion: null,
      health: "ok" as const,
      faults: [],
      observedAt: 0,
      simulated: true,
    };
    const policy = new CuePolicy({
      clock,
      log: captureLogger(),
      modules: { hapticTargets: () => [hand], sendHaptic: () => sent },
      playObstacleSound: () => at.push(clock.monotonic()),
      cues: () => cues,
    });
    return { policy, at };
  }

  it("C12: near, clear, invalid, near is a new entry (cues after the 1 s gap, not 3 s)", async () => {
    const clock = new FakeClock();
    const { policy, at } = soundPolicy(clock, true);
    policy.evaluate([zone(clock, 300)]);
    await clock.advance(100);
    policy.evaluate([zone(clock, 900)]);
    await clock.advance(100);
    policy.evaluate([zone(clock, null)]);
    await clock.advance(1000);
    policy.evaluate([zone(clock, 300)]);
    expect(at).toEqual([0, 1200]);
  });

  it("C13: vibration chosen but no haptic went out (busy port): the sound plays instead", () => {
    const clock = new FakeClock();
    const busy = soundPolicy(clock, false, ["vibration"]);
    busy.policy.evaluate([zone(clock, 300)]);
    expect(busy.at).toEqual([0]);
    const fine = soundPolicy(clock, true, ["vibration"]);
    fine.policy.evaluate([zone(clock, 300)]);
    expect(fine.at).toEqual([]);
  });

  it("B21: a proposal from a turn that timed out (its reply never heard) is declined, not offered", async () => {
    const h = makeHarness();
    await boot(h);
    h.fake.script = [{ reply: "Fake cloud: switch?", proposeCues: ["sound"] }];
    h.client.hold.add("turn");
    await talk(h);
    await h.clock.advance(10_000);
    expect(h.named("turn").map((t) => t.outcome)).toEqual(["timeout"]);
    h.client.releaseHeld(); // the server finishes the turn late and opens a proposal
    await flush();
    expect(h.device()!.proposals.at(-1)?.state).toBe("open");
    await h.clock.advance(15_000);
    expect(h.service.link).toBe("online");
    expect(h.client.calls.filter((c) => c === "answer:decline")).toHaveLength(1);
    expect(h.device()!.proposals.at(-1)?.state).toBe("declined");
    expect(h.service.openProposal).toBeNull();
  });

  it("P9: a credential that appears with an older device's configuration on disk fetches the server's", async () => {
    const h = makeHarness({ paired: false });
    h.store.writeConfiguration({
      version: 3,
      catalog_version: 1,
      selected_module_ids: ["base.walker", "controls.hand", "perception.tof", "voice"],
      cues: ["sound"],
      created_at: "2026-10-23T12:00:00.000Z",
    });
    await boot(h);
    const paired = h.fake.pair({ code: h.fake.issueCode(), service_version: "test" });
    h.store.writeCredential({ server_url: "https://walker.example.test", device_id: paired.device_id, credential: paired.credential });
    await h.clock.advance(5000);
    expect(h.service.configuration).toMatchObject({ version: 1, cues: ["vibration", "spoken"] });
  });

  it("W7: a spoken line that never finishes is stopped after 90 s and the next one plays", async () => {
    const h = makeHarness();
    h.speaker.hold = true;
    h.speaker.ignoreStop = true;
    await boot(h);
    h.client.network = "down";
    await h.clock.advance(10_000); // goes offline: the offline notice waits behind the hung boot line
    expect(h.speaker.spoken).toEqual(["Steady is on."]);
    await h.clock.advance(80_000);
    expect(h.speaker.stopped).toEqual(["Steady is on."]);
    expect(h.speaker.spoken).toEqual(["Steady is on.", "I'm offline right now."]);
  });
});

describe("S16: a re-hello from a known module (hello.request, PR #28)", () => {
  it("an answer to a hello.request (seq kept running) is not a reboot: the recording carries on", async () => {
    const h = makeHarness({ withHand: true });
    await boot(h);
    h.hand!.press("talk", "pressed");
    await h.clock.advance(1000);
    const hellos = () => h.log.lines.filter((line) => line.includes("module said hello")).length;
    const before = hellos();
    // The Pi asks again (as after the module came back); the module answers with seq still running.
    h.hand!.port.onPiLine(JSON.stringify({ v: 1, type: "hello.request", module_id: "hand-right-01", seq: 9 }));
    await flush();
    expect(hellos()).toBe(before + 1);
    expect(h.service.talk).toBe("recording");
    h.hand!.press("talk", "released");
    await flush();
    expect(h.client.calls).toContain("turn");
  });

  it("a reboot (seq back to 0) still discards it (B19)", async () => {
    const h = makeHarness({ withHand: true });
    await boot(h);
    h.hand!.press("talk", "pressed");
    await h.clock.advance(1000);
    h.hand!.start();
    await flush();
    expect(h.service.talk).toBe("idle");
    expect(h.client.calls).not.toContain("turn");
  });
});

it("S17: a known hand whose seq goes back on a heartbeat (its boot hello lost) counts as rebooted", async () => {
  const h = makeHarness({ withHand: true });
  await boot(h);
  await h.clock.advance(3000); // a few heartbeats: the hand's seq is past 0
  h.hand!.press("talk", "pressed");
  await h.clock.advance(1000);
  expect(h.service.talk).toBe("recording");
  const sentBefore = h.hand!.port.received.length;
  h.hand!.port.sendLine({ v: 1, type: "heartbeat", module_id: "hand-right-01", seq: 0, uptime_ms: 40, health: "ok" });
  await flush();
  expect(h.service.talk).toBe("idle");
  expect(h.client.calls).not.toContain("turn");
  expect(h.spoken("local_reply")).toEqual([LINES.stoppedListening]);
  const asked = h.hand!.port.received.slice(sentBefore).map((line) => JSON.parse(line));
  expect(asked).toEqual([expect.objectContaining({ type: "hello.request", module_id: "hand-right-01" })]);
});

describe("reported parts (S19-S21)", () => {
  const gpio = (health: "ok" | "unavailable") => ({
    instanceId: "pi-gpio-buttons",
    status: () => (health === "ok" ? { health, faults: [] } : { health, faults: ["gpiomon_stopped"] }),
  });
  const parts = (h: Harness) => h.service.manifest().modules.map((m) => `${m.module_id} ${m.instance_id} ${m.health} ${m.simulated}`);

  it("S19: the coordinator reports itself as the walker frame, simulated only in the simulator", async () => {
    const h = makeHarness();
    await boot(h);
    const frame = h.service.manifest().modules[0]!;
    expect(frame).toMatchObject({
      module_id: "base.walker",
      instance_id: "sim-coordinator",
      firmware_version: SERVICE_VERSION,
      protocol_version: null,
      health: "ok",
      faults: [],
      simulated: true,
    });
    // The server's status view then shows the frame healthy, not "unavailable".
    await h.clock.advance(5000);
    const status = h.fake.status(h.device()!);
    expect(status.parts.find((p) => p.module_id === "base.walker")).toMatchObject({ instance_id: "sim-coordinator", health: "ok", simulated: true });
  });

  it("S20: declared GPIO buttons are reported as hand controls, alongside any ESP32 hand, ok only while watched", async () => {
    const watched = makeHarness({ gpioButtons: gpio("ok"), withTof: true });
    await boot(watched);
    expect(parts(watched)).toContain("controls.hand pi-gpio-buttons ok false");
    const stopped = makeHarness({ gpioButtons: gpio("unavailable") });
    await boot(stopped);
    expect(stopped.service.manifest().modules.find((m) => m.instance_id === "pi-gpio-buttons")).toMatchObject({
      health: "unavailable",
      faults: ["gpiomon_stopped"],
    });
    const withBoard = makeHarness({ gpioButtons: gpio("ok"), withHand: true });
    await boot(withBoard);
    expect(parts(withBoard).filter((p) => p.startsWith("controls.hand"))).toEqual([
      "controls.hand hand-right-01 ok true",
      "controls.hand pi-gpio-buttons ok false",
    ]);
    // Not declared wired: no GPIO part at all, even with no ESP32 hand.
    const undeclared = makeHarness();
    await boot(undeclared);
    expect(parts(undeclared).some((p) => p.includes("pi-gpio-buttons"))).toBe(false);
  });

  it("S21: past 32 parts, ESP32 modules are cut first; the coordinator, GPIO buttons and voice stay", async () => {
    const h = makeHarness({ gpioButtons: gpio("ok") });
    await boot(h);
    for (let i = 0; i < 40; i += 1) {
      const port = new SimulatedPort(`p${i}`);
      h.modules.attach(port);
      port.sendLine({ v: 1, type: "hello", module_id: `tof-${i}`, seq: 0, module_type: "perception", capabilities: [] });
    }
    await flush();
    // A live hand that said hello after 40 sensors went silent is kept; old unavailable sensors are cut first.
    await h.clock.advance(4000);
    const live = new SimulatedPort("live");
    h.modules.attach(live);
    live.sendLine({ v: 1, type: "hello", module_id: "hand-late-01", seq: 0, module_type: "hand", capabilities: [] });
    await flush();
    const manifest = h.service.manifest();
    expect(manifest.modules.map((m) => m.instance_id)).toContain("hand-late-01");
    expect(manifest.modules).toHaveLength(32);
    expect(manifest.modules.map((m) => m.instance_id)).toEqual(expect.arrayContaining(["sim-coordinator", "pi-gpio-buttons", "test-audio"]));
    expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("S21: every part once, and nothing the walker doesn't have", async () => {
    const sim = makeHarness({ withHand: true, withTof: true });
    await boot(sim);
    expect(parts(sim)).toEqual([
      "base.walker sim-coordinator ok true",
      "controls.hand hand-right-01 ok true",
      "perception.tof tof-front-01 ok true",
      "voice test-audio ok true",
    ]);
    const bare = makeHarness();
    await boot(bare);
    expect(parts(bare)).toEqual(["base.walker sim-coordinator ok true", "voice test-audio ok true"]);
    expect(CapabilityManifestSchema.safeParse(sim.service.manifest()).success).toBe(true);
  });

  it("S20: GpioButtons says ok once gpiomon has started, and unavailable once it stops", async () => {
    const clock = new FakeClock();
    const children: EventEmitter[] = [];
    const spawnChild = (() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 88,
        exitCode: null,
        signalCode: null,
        kill: () => true,
      });
      children.push(child);
      return child;
    }) as never;
    const buttons = new GpioButtons({ flavor: "v1", chip: "gpiochip0", pins: { talk: 17, confirm: 27 } }, { clock, log: captureLogger(), bus: new Bus(), spawnChild });
    let watched = 0;
    buttons.onWatching = () => (watched += 1);
    expect(buttons.status().health).toBe("unavailable");
    buttons.start();
    children[0]!.emit("spawn");
    await clock.advance(999);
    expect(buttons.status()).toEqual({ health: "unavailable", faults: ["gpiomon_starting"] }); // not yet held for 1 s
    await clock.advance(1);
    expect(buttons.status()).toEqual({ health: "ok", faults: [] });
    expect(watched).toBe(1);
    children[0]!.emit("close", 1);
    expect(buttons.status()).toEqual({ health: "unavailable", faults: ["gpiomon_stopped"] });
    // A gpiomon that exits at once (a wrong chip) never reads ok, through any number of restarts.
    for (let i = 1; i <= 3; i += 1) {
      await clock.advance(5000);
      children[i]!.emit("spawn");
      await clock.advance(10);
      children[i]!.emit("close", 1);
      await clock.advance(2000);
      expect(buttons.status().health).toBe("unavailable");
    }
    await clock.advance(5000);
    buttons.stop();
    children[4]!.emit("spawn"); // a spawn that lands after stop changes nothing
    await clock.advance(2000);
    expect(buttons.status()).toEqual({ health: "unavailable", faults: ["gpiomon_stopped"] });
    expect(watched).toBe(1);
  });
});

it("S20: once the GPIO buttons count as watched, the walker reports it at once, not at the next tick", async () => {
  const h = makeHarness();
  await boot(h);
  await h.clock.advance(1000);
  const before = h.client.calls.filter((c) => c === "heartbeat").length;
  h.service.reportSoon();
  await h.clock.advance(0);
  expect(h.client.calls.filter((c) => c === "heartbeat").length).toBe(before + 1);
});

describe("C14: a hand board that can't buzz (the firmware's haptic faults)", () => {
  async function nearWith(setup: (h: Harness) => void) {
    const h = makeHarness({ withHand: true, withTof: true }); // configuration 1: vibration
    setup(h);
    await boot(h);
    await h.clock.advance(1500); // a heartbeat from the hand carries its health and faults
    h.tof!.readings.front_left = { mm: 300 };
    await h.clock.advance(200);
    return h;
  }

  it("a healthy hand with haptics buzzes, and no sound plays", async () => {
    const h = await nearWith(() => {});
    expect(h.named("haptic")).toHaveLength(1);
    expect(h.speaker.cues).not.toContain("obstacle");
  });

  it.each([
    ["haptic_error (the driver stopped answering)", { health: "degraded" as const, faults: ["haptic_error"] }],
    ["haptic_error even with ok health", { health: "ok" as const, faults: ["haptic_error"] }],
    ["haptic_missing", { health: "degraded" as const, faults: ["haptic_missing"], noHaptic: true }],
    ["any other degraded state (tx_dropped)", { health: "degraded" as const, faults: ["tx_dropped"] }],
    ["fault health", { health: "fault" as const, faults: ["line_not_built"] }],
  ])("%s: no buzz is sent; the short sound plays instead", async (_name, state) => {
    const h = await nearWith((harness) => {
      harness.hand!.health = state.health;
      harness.hand!.faults = state.faults;
      if ("noHaptic" in state) harness.hand!.hasHaptic = false;
    });
    expect(h.named("haptic")).toEqual([]);
    expect(h.hand!.port.received.filter((line) => line.includes("haptic.play"))).toEqual([]);
    expect(h.speaker.cues).toContain("obstacle");
  });

  it("the offline line follows the same rule: no promise of vibration from a hand that can't buzz", async () => {
    const h = await nearWith((harness) => {
      harness.hand!.health = "degraded";
      harness.hand!.faults = ["haptic_error"];
    });
    h.client.network = "down";
    await h.clock.advance(10_000);
    expect(h.spoken("notice").at(-1)).toBe("I'm offline right now. Your short-sound alerts still work. The obstacle sensor is simulated.");
  });
});
