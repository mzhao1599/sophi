import { EventEmitter } from "node:events";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CommandCapture, FileCapture } from "../src/audio/capture";
import { CUE_TONES, readWav, toneWav, wavFromPcm } from "../src/audio/wav";
import { checkServerUrl } from "../src/cloud/client";
import { appliedLine, moduleDownLine, offlineLine } from "../src/notices";
import type { ModuleView } from "../src/serial/modules";
import { parseScript } from "../src/sim/script";
import { StateStore } from "../src/store";
import { captureLogger, flush } from "./support/fakes";

const part = (over: Partial<ModuleView>): ModuleView => ({
  instanceId: "x",
  type: "perception",
  catalogId: "perception.tof",
  capabilities: [],
  firmwareVersion: null,
  health: "ok",
  faults: [],
  observedAt: 0,
  simulated: false,
  ...over,
});
const tof = part({ instanceId: "tof-front-01" });
const hand = part({ instanceId: "hand-left-01", type: "hand", catalogId: "controls.hand", capabilities: ["haptic"] });

describe("fixed local lines", () => {
  it("O5: the offline line says only what is true of the parts right now", () => {
    expect(offlineLine(["sound"], [tof, hand])).toBe("I'm offline right now. Your short-sound alerts still work.");
    expect(offlineLine(["vibration", "spoken"], [tof, hand])).toBe("I'm offline right now. Your vibration alerts still work.");
    expect(offlineLine(["vibration", "sound"], [tof, hand])).toBe(
      "I'm offline right now. Your vibration and short-sound alerts still work.",
    );
    expect(offlineLine(["vibration"], [tof, { ...hand, health: "unavailable" }])).toBe(
      "I'm offline right now. Your short-sound alerts still work.",
    );
    expect(offlineLine(["sound"], [{ ...tof, health: "unavailable" }])).toBe(
      "I'm offline right now. The obstacle sensor isn't responding, so obstacle alerts are off.",
    );
    expect(offlineLine(["sound"], [{ ...tof, simulated: true }])).toBe(
      "I'm offline right now. Your short-sound alerts still work. The obstacle sensor is simulated.",
    );
    expect(offlineLine(null, [])).toBe("I'm offline right now.");
  });

  it("the applied line comes from the new configuration", () => {
    expect(appliedLine(["sound"])).toBe("Done. Obstacle alerts now use short sounds.");
    expect(appliedLine(["vibration", "spoken"])).toBe("Done. Obstacle alerts now use vibration.");
    expect(appliedLine(["vibration", "sound"])).toBe("Done. Obstacle alerts now use vibration and short sounds.");
  });

  it("S7: names the part that stopped responding", () => {
    expect(moduleDownLine(tof)).toBe("Your obstacle sensor stopped responding.");
    expect(moduleDownLine(hand)).toBe("Your left hand control stopped responding.");
    expect(moduleDownLine({ type: "hand", instanceId: "hand-02" })).toBe("Your hand control stopped responding.");
  });
});

describe("audio files", () => {
  it("W1: builds a 16 kHz mono 16-bit WAV whose sizes match", () => {
    const wav = wavFromPcm(Buffer.alloc(64_000), 16000);
    expect(wav.length).toBe(64_044);
    expect(wav.readUInt32LE(4)).toBe(64_036);
    expect(readWav(wav)).toMatchObject({ format: 1, sampleRate: 16000, channels: 1, bitsPerSample: 16 });
    expect(readWav(wav).pcm.length).toBe(64_000);
  });

  it("W2: the file mic accepts a 16 kHz mono WAV, caps it at 15 s, and refuses other formats", async () => {
    const dir = mkdtempSync(join(tmpdir(), "walker-wav-"));
    const long = join(dir, "long.wav");
    writeFileSync(long, wavFromPcm(Buffer.alloc(20 * 32_000, 1), 16000));
    const clip = await new FileCapture(long).start().stop();
    expect(clip.durationMs).toBe(15_000);
    expect(clip.wav.length).toBe(480_044);
    const wrong = join(dir, "wrong.wav");
    writeFileSync(wrong, wavFromPcm(Buffer.alloc(100), 44100));
    expect(() => new FileCapture(wrong)).toThrow(/ffmpeg -i <input> -ar 16000 -ac 1/);
  });

  it("the command mic (arecord's shape) keeps raw PCM from stdout, capped at 15 s, and stops it with SIGINT", async () => {
    const signals: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 4242,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill(signal: string) {
        signals.push(signal);
        child.signalCode = signal;
        child.stdout.end();
        setImmediate(() => child.emit("close", null, signal));
        return true;
      },
    });
    const capture = new CommandCapture("test", "arecord", [], captureLogger(), false, (() => child) as never);
    const session = capture.start();
    child.stdout.write(Buffer.alloc(640_000, 1));
    await flush();
    const clip = await session.stop();
    expect(signals).toEqual(["SIGINT"]);
    expect(clip.durationMs).toBe(15_000);
    expect(readWav(clip.wav)).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16 });
    expect(readWav(clip.wav).pcm.length).toBe(480_000);
  });

  it("a mic command that can't start fails the recording instead of hanging", async () => {
    const capture = new CommandCapture("test", "walker-no-such-recorder", [], captureLogger());
    await expect(capture.start().stop()).rejects.toThrow(/could not start/);
  });

  it("W3: every cue sound is a short WAV", () => {
    for (const notes of Object.values(CUE_TONES)) {
      const info = readWav(toneWav(notes));
      expect(info.pcm.length / 2 / info.sampleRate).toBeLessThan(0.5);
    }
  });
});

describe("state store", () => {
  it("P3: the credential file is 0600 in a 0700 folder", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "walker-state-")), "state");
    const store = new StateStore(dir, captureLogger());
    store.writeCredential({ server_url: "https://walker.example.test", device_id: "55555555-5555-4555-8555-555555555555", credential: "c".repeat(43) });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "credential.json")).mode & 0o777).toBe(0o600);
    expect(store.readCredential()?.device_id).toBe("55555555-5555-4555-8555-555555555555");
  });

  it("puts a too-open credential file back to 0600", async () => {
    const { chmodSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "walker-state-"));
    const log = captureLogger();
    const store = new StateStore(dir, log);
    store.writeCredential({ server_url: "https://walker.example.test", device_id: "55555555-5555-4555-8555-555555555555", credential: "c".repeat(43) });
    chmodSync(join(dir, "credential.json"), 0o644);
    store.readCredential();
    expect(statSync(join(dir, "credential.json")).mode & 0o777).toBe(0o600);
    expect(log.lines.join("\n")).not.toContain("c".repeat(43));
  });

  it("O8: the event queue keeps the newest 50, measures ago_ms on the monotonic clock, and drops what was delivered", () => {
    const store = new StateStore(mkdtempSync(join(tmpdir(), "walker-state-")), captureLogger());
    for (let i = 0; i < 60; i += 1) store.pushEvent({ event_id: `e${i}`, kind: "notice", text: `line ${i}`, saidMono: i * 100 });
    const pending = store.pendingEvents(10_000);
    expect(pending).toHaveLength(50);
    expect(pending[0]).toEqual({ event_id: "e10", kind: "notice", text: "line 10", ago_ms: 9000 });
    store.acknowledgeEvents(pending.slice(0, 45).map((e) => e.event_id));
    expect(store.pendingEvents(10_000).map((e) => e.event_id)).toEqual(["e55", "e56", "e57", "e58", "e59"]);
  });

  it("O8: a line older than 24 h is dropped for good, so it can't get every heartbeat refused", () => {
    const store = new StateStore(mkdtempSync(join(tmpdir(), "walker-state-")), captureLogger());
    store.pushEvent({ event_id: "old", kind: "notice", text: "Steady is on.", saidMono: 0 });
    store.pushEvent({ event_id: "new", kind: "local_reply", text: "Cancelled.", saidMono: 60_000 });
    expect(store.pendingEvents(24 * 3_600_000).map((e) => e.event_id)).toEqual(["old", "new"]);
    expect(store.pendingEvents(24 * 3_600_000 + 1).map((e) => e.event_id)).toEqual(["new"]);
    expect(store.pendingEvents(0).map((e) => e.event_id)).toEqual(["new"]);
  });
});

describe("misc", () => {
  it("plain http is refused except to this machine", () => {
    expect(() => checkServerUrl("http://walker.example.test")).toThrow(/https/);
    expect(checkServerUrl("http://127.0.0.1:4000").port).toBe("4000");
    expect(checkServerUrl("https://walker.example.test").protocol).toBe("https:");
  });

  it("the simulator script parser reads keys, expectations and waits, and refuses unknown lines", () => {
    expect(parseScript("# c\nkey t\nexpect spoke Steady is on.\nabsent 500 haptic\nwait 100\n")).toEqual([
      { kind: "key", key: "t", line: 2 },
      { kind: "expect", event: "spoke", match: "Steady is on.", timeoutMs: 20_000, line: 3 },
      { kind: "absent", event: "haptic", match: "", forMs: 500, line: 4 },
      { kind: "wait", forMs: 100, line: 5 },
    ]);
    expect(() => parseScript("expect nonsense")).toThrow(/unknown event/);
    expect(() => parseScript("press t")).toThrow(/can't read/);
  });
});
