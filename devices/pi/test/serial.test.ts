import { readFileSync } from "node:fs";
import { SerialHapticPlaySchema, type SerialParseResult } from "@walker/contracts";
import { describe, expect, it } from "vitest";
import { Bus } from "../src/bus";
import { LineReader } from "../src/serial/lineReader";
import { ModuleManager } from "../src/serial/modules";
import { SimulatedHand, SimulatedPort, SimulatedTof } from "../src/sim/fakeModules";
import { FakeClock, captureLogger, flush } from "./support/fakes";

const fixtures = new URL("../../../packages/contracts/test/fixtures/", import.meta.url);
const validLines = readFileSync(new URL("serial-v1.valid.jsonl", fixtures), "utf8").split("\n").filter(Boolean);
const invalidCases = JSON.parse(readFileSync(new URL("serial-v1.invalid.json", fixtures), "utf8")) as Array<{
  expect: string;
  why: string;
  line: string;
}>;
const heartbeat = '{"v":1,"type":"heartbeat","module_id":"tof-front-01","seq":84,"uptime_ms":27002,"health":"ok"}';

function reader() {
  const results: SerialParseResult[] = [];
  return { results, reader: new LineReader((result) => results.push(result)) };
}

describe("line reader on the shared fixtures", () => {
  it("S1: parses every valid fixture line", () => {
    const { results, reader: r } = reader();
    r.push(Buffer.from(validLines.map((line) => `${line}\n`).join("")));
    expect(results).toHaveLength(validLines.length);
    results.forEach((result, i) => {
      expect(result.ok, validLines[i]).toBe(true);
      if (result.ok) expect(result.message).toEqual(JSON.parse(validLines[i]!));
    });
  });

  it.each(invalidCases)("S2: refuses '$why' as $expect and carries on", ({ expect: problem, line }) => {
    const { results, reader: r } = reader();
    r.push(Buffer.from(`${line}\n${heartbeat}\n`));
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: false, problem });
    expect(results[1]?.ok).toBe(true);
  });

  it("S3: a line split at every byte boundary parses the same, including inside a UTF-8 character", () => {
    const line = Buffer.from('{"v":1,"type":"error","module_id":"hand-left-01","seq":3,"code":"malformed","detail":"café ☕"}\n');
    for (let cut = 1; cut < line.length; cut += 1) {
      const { results, reader: r } = reader();
      r.push(line.subarray(0, cut));
      r.push(line.subarray(cut));
      expect(results, `cut at ${cut}`).toHaveLength(1);
      expect(results[0]).toMatchObject({ ok: true, message: { detail: "café ☕" } });
    }
  });

  it("S4: an oversize line is reported once, dropped to its newline, and the buffer stays bounded", () => {
    const { results, reader: r } = reader();
    for (let i = 0; i < 20; i += 1) {
      r.push(Buffer.alloc(100, 0x61));
      expect(r.buffered).toBeLessThan(1024);
    }
    r.push(Buffer.from(`\n${heartbeat}\n`));
    expect(results.map((x) => (x.ok ? "ok" : x.problem))).toEqual(["oversize", "ok"]);
  });

  it("S4: a line of exactly 1024 bytes with its newline is accepted, 1025 is not", () => {
    const pad = (n: number) => {
      const base = '{"v":1,"type":"error","module_id":"hand-left-01","seq":1,"code":"malformed","detail":""}';
      return base.replace('"detail":""', `"detail":"${"x".repeat(n - base.length - 1)}"`);
    };
    const { results, reader: r } = reader();
    // detail is capped at 120 by the schema, so check size handling alone: the 1024-byte line reaches the
    // parser (invalid_field), the 1025-byte one is refused as oversize before parsing.
    r.push(Buffer.from(`${pad(1024)}\n${pad(1025)}\n`));
    expect(results.map((x) => (x.ok ? "ok" : x.problem))).toEqual(["invalid_field", "oversize"]);
  });

  it("S5: CRLF parses, blank lines are skipped, invalid UTF-8 is malformed", () => {
    const { results, reader: r } = reader();
    r.push(Buffer.concat([Buffer.from(`${heartbeat}\r\n\n  \n`), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from(`${heartbeat}\n`)]));
    expect(results.map((x) => (x.ok ? "ok" : x.problem))).toEqual(["ok", "malformed", "ok"]);
  });
});

function manager() {
  const clock = new FakeClock();
  const bus = new Bus();
  const log = captureLogger();
  const modules = new ModuleManager({ clock, log, bus });
  const down: string[] = [];
  const buttons: string[] = [];
  bus.on("moduleDown", ({ module, reason }) => down.push(`${module.instanceId} ${reason}`));
  bus.on("button", ({ button, edge, source }) => buttons.push(`${source} ${button} ${edge}`));
  return { clock, bus, log, modules, down, buttons };
}

describe("module manager", () => {
  it("S6: hello then heartbeats register the module with its type, capabilities and firmware", async () => {
    const { clock, modules } = manager();
    const port = new SimulatedPort("p1");
    modules.attach(port);
    const tof = new SimulatedTof(port, "tof-front-01", clock);
    tof.start();
    await clock.advance(2500);
    expect(modules.modules()).toEqual([
      expect.objectContaining({
        instanceId: "tof-front-01",
        type: "perception",
        catalogId: "perception.tof",
        capabilities: ["zones"],
        firmwareVersion: "sim-0.1.0",
        health: "ok",
        simulated: true,
      }),
    ]);
  });

  it("S7: three seconds without a heartbeat marks it unavailable once; a new hello brings it back", async () => {
    const { clock, modules, down } = manager();
    const port = new SimulatedPort("p1");
    modules.attach(port);
    const tof = new SimulatedTof(port, "tof-front-01", clock);
    tof.start();
    await clock.advance(1500);
    expect(modules.currentZones().length).toBe(2);
    tof.hang();
    await clock.advance(1499);
    expect(modules.modules()[0]?.health).toBe("ok");
    await clock.advance(2000);
    expect(modules.modules()[0]).toMatchObject({ health: "unavailable", faults: ["heartbeat_timeout"] });
    expect(modules.currentZones()).toEqual([]);
    await clock.advance(10_000);
    expect(down).toEqual(["tof-front-01 heartbeat_timeout"]);
    tof.start();
    await clock.advance(10);
    expect(modules.modules()[0]).toMatchObject({ health: "ok", faults: [] });
    expect(down).toHaveLength(1);
  });

  it("S8: a closed port marks its module unavailable at once", async () => {
    const { clock, modules, down } = manager();
    const port = new SimulatedPort("p1");
    modules.attach(port);
    new SimulatedHand(port, "hand-left-01", clock).start();
    await clock.advance(10);
    port.unplug();
    expect(modules.modules()[0]).toMatchObject({ health: "unavailable", faults: ["disconnected"] });
    expect(down).toEqual(["hand-left-01 disconnected"]);
  });

  it("S9: lines before a hello are ignored and counted", async () => {
    const { clock, modules, log, buttons } = manager();
    const port = new SimulatedPort("p1");
    modules.attach(port);
    port.sendLine({ v: 1, type: "heartbeat", module_id: "hand-left-01", seq: 5, uptime_ms: 10, health: "ok" });
    port.sendLine({ v: 1, type: "hand.input", module_id: "hand-left-01", seq: 6, uptime_ms: 11, button: "talk", edge: "pressed" });
    await clock.advance(10);
    expect(modules.modules()).toEqual([]);
    expect(buttons).toEqual([]);
    expect(log.lines.some((line) => line.includes("hasn't said hello"))).toBe(true);
  });

  it("B12: hand buttons count only when declared in the hello; trigger-only lines are not buttons", async () => {
    const { clock, modules, buttons } = manager();
    const port = new SimulatedPort("p1");
    modules.attach(port);
    const hand = new SimulatedHand(port, "hand-left-01", clock);
    hand.start();
    hand.press("talk", "pressed");
    hand.press("talk", "released");
    hand.press("confirm", "pressed");
    port.sendLine({ v: 1, type: "hand.input", module_id: "hand-left-01", seq: 50, uptime_ms: 1, trigger: 0.4 });
    port.sendLine({ v: 1, type: "hand.input", module_id: "hand-left-01", seq: 51, uptime_ms: 1, button: "primary", edge: "pressed" });
    await clock.advance(10);
    expect(buttons).toEqual(["esp32 talk pressed", "esp32 talk released", "esp32 confirm pressed"]);

    const other = new SimulatedPort("p2");
    modules.attach(other);
    other.sendLine({ v: 1, type: "hello", module_id: "hand-right-01", seq: 0, module_type: "hand", capabilities: ["haptic"] });
    other.sendLine({ v: 1, type: "hand.input", module_id: "hand-right-01", seq: 1, uptime_ms: 1, button: "talk", edge: "pressed" });
    await clock.advance(10);
    expect(buttons).toHaveLength(3);
  });

  it("S10: haptic.play is schema-valid, fits a line, and the Pi's seq counts up per port", async () => {
    const { clock, modules } = manager();
    const port = new SimulatedPort("p1");
    modules.attach(port);
    new SimulatedHand(port, "hand-left-01", clock).start();
    await clock.advance(10);
    expect(modules.sendHaptic("hand-left-01", "near_obstacle", 400)).toBe(true);
    expect(modules.sendHaptic("hand-left-01", "error", 1000)).toBe(true);
    expect(modules.sendHaptic("hand-left-01", "error", 1001)).toBe(false);
    expect(port.received).toHaveLength(2);
    const sent = port.received.map((line) => SerialHapticPlaySchema.parse(JSON.parse(line)));
    expect(sent.map((m) => m.seq)).toEqual([0, 1]);
    expect(port.received.every((line) => Buffer.byteLength(line) <= 1024 && line.endsWith("\n"))).toBe(true);
    expect(modules.sendHaptic("nobody", "error", 100)).toBe(false);
  });

  it("C10: zones from an unavailable module are not current; readings expire after 500 ms", async () => {
    const { clock, modules } = manager();
    const port = new SimulatedPort("p1");
    modules.attach(port);
    port.sendLine({ v: 1, type: "hello", module_id: "tof-front-01", seq: 0, module_type: "perception", capabilities: [] });
    port.sendLine({
      v: 1,
      type: "perception.zones",
      module_id: "tof-front-01",
      seq: 1,
      uptime_ms: 5,
      zones: [{ name: "front_left", mm: 300, quality: "valid" }],
    });
    await flush();
    expect(modules.currentZones()).toHaveLength(1);
    await clock.advance(499);
    expect(modules.currentZones()).toHaveLength(1);
    await clock.advance(1);
    expect(modules.currentZones()).toHaveLength(0);
  });
});
