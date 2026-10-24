import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileCapture, resolveMicFiles } from "../src/audio/capture";
import { wavFromPcm } from "../src/audio/wav";
import { withDeadline } from "../src/clock";
import { LINES } from "../src/notices";
import { NetworkSwitch, SwitchableCloudClient } from "../src/sim/networkSwitch";
import { FakeClock, boot, flush, makeHarness, type Harness } from "./support/fakes";

/** Rows from the demo rehearsal (test/EXPECTED.md, marked "rehearsal"): W8, O11, O12, B22. */

const clip = (ms: number, fill: number) => wavFromPcm(Buffer.alloc(ms * 32, fill), 16000);

async function talk(h: Harness, ms = 2000): Promise<void> {
  h.press("talk", "pressed");
  await h.clock.advance(ms);
  h.press("talk", "released");
  await flush();
}

describe("W8: the simulator's mic plays a list of clips, read again at each press", () => {
  it("a comma list or a folder gives the clips in order, starting again after the last", async () => {
    const dir = mkdtempSync(join(tmpdir(), "walker-clips-"));
    const beats = join(dir, "beats");
    mkdirSync(beats);
    writeFileSync(join(beats, "2-settings.wav"), clip(200, 2));
    writeFileSync(join(beats, "1-ask.wav"), clip(100, 1));
    writeFileSync(join(beats, "notes.txt"), "not a clip");
    expect(resolveMicFiles(beats)).toEqual([join(beats, "1-ask.wav"), join(beats, "2-settings.wav")]);
    const a = join(dir, "a.wav");
    writeFileSync(a, clip(300, 3));
    expect(resolveMicFiles(`${a}, ${beats}`)).toEqual([a, join(beats, "1-ask.wav"), join(beats, "2-settings.wav")]);

    const mic = new FileCapture(resolveMicFiles(beats));
    const lengths = [];
    for (let i = 0; i < 3; i += 1) lengths.push((await mic.start().stop()).durationMs);
    expect(lengths).toEqual([100, 200, 100]);
  });

  it("a clip edited between presses is read again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "walker-clips-"));
    const path = join(dir, "ask.wav");
    writeFileSync(path, clip(100, 1));
    const mic = new FileCapture([path]);
    expect((await mic.start().stop()).durationMs).toBe(100);
    writeFileSync(path, clip(400, 1));
    expect((await mic.start().stop()).durationMs).toBe(400);
  });

  it("a bad clip anywhere in the list is refused at start, and an empty folder too", () => {
    const dir = mkdtempSync(join(tmpdir(), "walker-clips-"));
    const good = join(dir, "good.wav");
    const bad = join(dir, "bad.wav");
    writeFileSync(good, clip(100, 1));
    writeFileSync(bad, wavFromPcm(Buffer.alloc(100), 44100));
    expect(() => new FileCapture([good, bad])).toThrow(/bad\.wav must be a 16 kHz mono 16-bit WAV/);
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(() => resolveMicFiles(empty)).toThrow(/no \.wav files/);
  });
});

describe("O12: the simulator's network switch works on any server", () => {
  it("down fails at once as unreachable; hang waits for the deadline; up passes through", async () => {
    const h = makeHarness();
    await boot(h);
    const network = new NetworkSwitch();
    const client = new SwitchableCloudClient(h.client, network);
    const body = { sent_at: new Date().toISOString(), service_version: "t", manifest: h.service.manifest(), snapshot: null, events: [] };
    network.mode = "down";
    await expect(client.heartbeat(body, new AbortController().signal)).rejects.toMatchObject({ kind: "unreachable" });
    network.mode = "hang";
    const clock = new FakeClock();
    let settled: unknown = null;
    const pending = withDeadline(clock, 5000, (signal) => client.heartbeat(body, signal)).catch((error) => (settled = error));
    await clock.advance(4999);
    expect(settled).toBeNull();
    await clock.advance(1);
    await pending;
    expect(settled).toMatchObject({ name: "DeadlineError" });
    network.mode = "up";
    await expect(client.heartbeat(body, new AbortController().signal)).resolves.toMatchObject({ configuration_version: 1 });
  });
});

describe("B22: a new configuration is reported at once", () => {
  it("after Confirm, the next heartbeat goes out right away and carries the new version", async () => {
    const h = makeHarness();
    await boot(h);
    h.fake.script = [{ reply: "Fake cloud: switch?", proposeCues: ["sound"] }];
    await talk(h);
    h.press("confirm");
    await flush();
    expect(h.service.configuration?.version).toBe(2);
    await h.clock.advance(0);
    expect(h.device()!.lastHeartbeat!.manifest.device_configuration_version).toBe(2);
  });

  it("a configuration learned from a heartbeat is reported right after that heartbeat", async () => {
    const h = makeHarness();
    await boot(h);
    const device = h.device()!;
    device.configurations.push({ ...h.fake.current(device), version: 2, cues: ["sound"] });
    await h.clock.advance(5000); // this heartbeat learns version 2 and fetches it
    expect(h.service.configuration?.version).toBe(2);
    await h.clock.advance(0); // the follow-up heartbeat goes at once, not 5 s later
    expect(h.device()!.lastHeartbeat!.manifest.device_configuration_version).toBe(2);
  });

  it("a report asked for during a heartbeat that then fails keeps the backoff", async () => {
    const h = makeHarness();
    await boot(h);
    const times: number[] = [];
    h.bus.on("heartbeat", () => times.push(h.clock.monotonic()));
    h.client.hold.add("heartbeat");
    await h.clock.advance(5000); // the 5 s heartbeat is sent and held
    h.service.reportSoon();
    h.client.hold.delete("heartbeat"); // later heartbeats answer at once, so an early one would show
    await h.clock.advance(5000); // the held one's deadline: a failure at 10 s
    await h.clock.advance(4999);
    expect(times).toEqual([10_000]); // no extra heartbeat right after the failure: the backoff holds
    await h.clock.advance(1);
    expect(times).toEqual([10_000, 15_000]);
  });
});

describe("O11: the same local line twice within 30 s is spoken both times, sent once", () => {
  it("Confirm with nothing open, twice: two sounds, one line on the page", async () => {
    const h = makeHarness();
    await boot(h);
    h.press("confirm");
    await flush();
    await h.clock.advance(10_000);
    h.press("confirm");
    await flush();
    await h.clock.advance(5000); // the next heartbeat would carry a second copy, if one were queued
    expect(h.speaker.cues.filter((c) => c === "nothing_to_confirm")).toHaveLength(2);
    expect(h.device()!.events.filter((e) => e.text === LINES.nothingToConfirm)).toHaveLength(1);
  });

  it("after 30 s the same line is sent again", async () => {
    const h = makeHarness();
    await boot(h);
    h.press("confirm");
    await flush();
    await h.clock.advance(30_000);
    h.press("confirm");
    await flush();
    await h.clock.advance(5000);
    expect(h.device()!.events.filter((e) => e.text === LINES.nothingToConfirm)).toHaveLength(2);
  });
});

it("the mic-open event comes once the listening sound is done, so scripts hold Talk from there", async () => {
  const h = makeHarness();
  await boot(h);
  const order: string[] = [];
  h.bus.on("cue", ({ name }) => order.push(`cue ${name}`));
  h.bus.on("mic", ({ state }) => order.push(`mic ${state}`));
  h.press("talk", "pressed");
  await flush();
  expect(order).toEqual(["cue listening", "mic open"]);
  expect(h.capture.starts).toBe(1);
});

describe("after the review", () => {
  it("O11: a second identical line after something else happened (a new recording) still reaches the page", async () => {
    const h = makeHarness();
    await boot(h);
    h.client.hold.add("turn");
    for (let i = 0; i < 2; i += 1) {
      await talk(h);
      h.press("talk", "pressed"); // cancels the waiting turn
      await flush();
    }
    await h.clock.advance(5000);
    expect(h.device()!.events.filter((e) => e.text === LINES.cancelled)).toHaveLength(2);
  });

  it("O11: a reply between two 'Nothing to confirm.' lines makes the second one new", async () => {
    const h = makeHarness();
    await boot(h);
    h.press("confirm");
    await flush();
    await talk(h);
    h.press("confirm");
    await flush();
    await h.clock.advance(5000);
    expect(h.device()!.events.filter((e) => e.text === LINES.nothingToConfirm)).toHaveLength(2);
  });

  it("O11: a Confirm result between two 'Nothing to confirm.' lines (no recording at all) makes the second one new", async () => {
    const h = makeHarness();
    await boot(h);
    h.press("confirm"); // nothing open
    await flush();
    // A proposal opened elsewhere (the page's own turn): the walker learns it from a heartbeat, no recording here.
    const device = h.device()!;
    const now = h.clock.now();
    device.proposals.push({
      proposal_id: "77777777-7777-4777-8777-777777777777",
      client_turn_id: "88888888-8888-4888-8888-888888888888",
      kind: "cues_change",
      from_cues: ["vibration", "spoken"],
      cues: ["sound"],
      base_configuration_version: 1,
      summary: "Switch obstacle alerts to short sounds.",
      state: "open",
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      configuration_version: null,
    });
    await h.clock.advance(5000);
    h.press("confirm"); // confirms it: "Done. ..."
    await flush();
    expect(h.spoken("confirm_result")).toEqual(["Done. Obstacle alerts now use short sounds."]);
    h.press("confirm"); // nothing open again
    await flush();
    await h.clock.advance(5000);
    expect(h.device()!.events.filter((e) => e.text === LINES.nothingToConfirm)).toHaveLength(2);
  });

  it("W8: a press too short to send doesn't use up its clip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "walker-clips-"));
    writeFileSync(join(dir, "1.wav"), clip(100, 1));
    writeFileSync(join(dir, "2.wav"), clip(200, 2));
    const mic = new FileCapture(resolveMicFiles(dir));
    mic.start().abort(); // too short: thrown away
    expect((await mic.start().stop()).durationMs).toBe(100);
    expect((await mic.start().stop()).durationMs).toBe(200);
  });

  it("W8: a folder sorts naturally, skips hidden files, and names a file that isn't a WAV", () => {
    const dir = mkdtempSync(join(tmpdir(), "walker-clips-"));
    writeFileSync(join(dir, "10-later.wav"), clip(100, 1));
    writeFileSync(join(dir, "2-first.wav"), clip(100, 1));
    writeFileSync(join(dir, "._2-first.wav"), "macOS resource fork");
    expect(resolveMicFiles(dir)).toEqual([join(dir, "2-first.wav"), join(dir, "10-later.wav")]);
    const junk = join(dir, "junk.wav");
    writeFileSync(junk, "not audio");
    expect(() => new FileCapture([junk])).toThrow(`${junk}: Not a WAV file.`);
  });

  it("B22: a server whose heartbeat and configuration answers disagree can't make the walker loop", async () => {
    const h = makeHarness();
    await boot(h);
    const heartbeat = h.fake.heartbeat.bind(h.fake);
    h.fake.heartbeat = (device, body) => ({ ...heartbeat(device, body), configuration_version: 99 });
    const times: number[] = [];
    h.bus.on("heartbeat", () => times.push(h.clock.monotonic()));
    await h.clock.advance(20_000);
    expect(times).toEqual([5000, 10_000, 15_000, 20_000]); // every 5 s, fetching each time, never a burst
  });
});
