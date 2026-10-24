import { describe, expect, it } from "vitest";
import type { CheckContext, CheckLine, Runner } from "../src/check/core";
import { HELLO_WAIT_MS, PRESS_WAIT_MS, SIM_MODULES, moduleLines, simulatedSerial, type SerialSource } from "../src/check/modules";
import { SimulatedHand, SimulatedPort, SimulatedTof } from "../src/sim/fakeModules";
import { FakeClock } from "./support/fakes";

/**
 * Rows K15–K19 and K22 (test/EXPECTED.md): the serial check on simulated boards, through the same
 * ModuleManager and line reader the service uses, on a fake clock. Real ESP32 boards were not used.
 */

type Board = { port: SimulatedPort; board?: SimulatedHand | SimulatedTof };

function sourceOf(boards: Board[]): SerialSource & { opened: string[] } {
  const opened: string[] = [];
  return {
    simulated: false,
    opened,
    ports: () => boards.map((b) => b.port.id),
    open: (path) => {
      opened.push(path);
      return boards.find((b) => b.port.id === path)!.port;
    },
    started: () => boards.forEach((b) => b.board?.start()),
    stop: () => boards.forEach((b) => b.board?.hang()),
  };
}

function ctxFor(clock: FakeClock, options: Partial<CheckContext["options"]> = {}, over: Partial<CheckContext> = {}): CheckContext & { said: string[] } {
  const said: string[] = [];
  return {
    run: async () => ({ code: null, stdout: Buffer.alloc(0), stderr: "", missing: true, timedOut: false, ms: 0 }),
    files: { read: () => null, list: () => null, mode: () => null, size: () => null },
    clock,
    platform: "linux",
    arch: "arm64",
    env: {},
    say: (line) => said.push(line),
    facts: { serviceActive: false },
    said,
    ...over,
    options: { server: undefined, stateDir: "/x", stateDirGiven: false, sound: false, buzz: false, press: false, sim: false, ports: null, expect: [], ...options },
  };
}

function walker(clock: FakeClock) {
  const left = new SimulatedHand(new SimulatedPort("usb-Silicon_Labs_CP2102-left"), "hand-left-01", clock);
  const right = new SimulatedHand(new SimulatedPort("usb-Silicon_Labs_CP2102-right"), "hand-right-01", clock);
  const tof = new SimulatedTof(new SimulatedPort("usb-1a86_USB_Serial-tof"), "tof-front-01", clock);
  return { left, right, tof, boards: [left, right, tof].map((board) => ({ port: board.port, board })) };
}

async function check(clock: FakeClock, ctx: CheckContext, source: SerialSource, ms = 30_000): Promise<CheckLine[]> {
  const done = moduleLines(ctx, source);
  await clock.advance(ms);
  return done;
}

const byItem = (lines: CheckLine[]) => Object.fromEntries(lines.map((l) => [l.item, `${l.status} ${l.detail}`]));
const hapticLines = (port: SimulatedPort) => port.received.filter((line) => line.includes('"haptic.play"'));

describe("walker check: serial modules", () => {
  it("K16, K17, K2: three boards: each module with its details and the zones; no haptic and no press without the flags", async () => {
    const clock = new FakeClock();
    const w = walker(clock);
    const lines = await check(clock, ctxFor(clock), sourceOf(w.boards));
    const items = byItem(lines);
    expect(items["hand-left-01"]).toBe("PASS hand, firmware sim-0.1.0, protocol v1, health ok, can button.talk button.confirm trigger haptic, port usb-Silicon_Labs_CP2102-left (simulated)");
    expect(items["hand-right-01"]).toMatch(/^PASS hand, firmware sim-0\.1\.0/);
    expect(items["tof-front-01"]).toMatch(/^PASS perception, firmware sim-0\.1\.0, protocol v1, health ok, can zones/);
    expect(items["tof-front-01 zones"]).toMatch(/^PASS front_left 1500 mm valid, front_right 1500 mm valid; 1[0-4] reports in 1\.2 s$/);
    expect(items["hand-left-01 press"]).toBe("SKIP pass --press to check its buttons");
    expect(lines.filter((l) => l.status === "FAIL")).toEqual([]);
    expect(lines.some((l) => l.item.endsWith("buzz"))).toBe(false);
    for (const board of [w.left, w.right]) expect(hapticLines(board.port)).toEqual([]);
    // The check asked each port for a hello, exactly as the service does.
    expect(JSON.parse(w.left.port.received[0]!)).toEqual({ v: 1, type: "hello.request", module_id: "any", seq: 0 });
  });

  it("K16: degraded health warns; a port with no hello, a missing expected id and no ports at all fail", async () => {
    const clock = new FakeClock();
    const w = walker(clock);
    w.right.health = "degraded";
    w.right.faults = ["haptic_missing"];
    w.right.hasHaptic = false;
    const silent = new SimulatedPort("usb-unknown-board");
    const lines = await check(clock, ctxFor(clock, { buzz: true }), sourceOf([{ port: w.left.port, board: w.left }, { port: w.right.port, board: w.right }, { port: silent }]));
    const items = byItem(lines);
    expect(items["hand-right-01"]).toMatch(/^WARN hand, .*health degraded, faults haptic_missing/);
    expect(items["hand-right-01 buzz"]).toBe("FAIL can't buzz: no haptic in its hello (driver not found at boot)");
    expect(hapticLines(w.right.port)).toEqual([]);
    expect(items.port).toBe(`FAIL no hello within ${HELLO_WAIT_MS / 1000} s on usb-unknown-board (0 lines read, 0 unreadable): not our firmware, or the board is stuck in its bootloader`);
    expect(items["tof-front-01"]).toBe("FAIL not seen on any port");
    const none = await check(clock, ctxFor(clock), sourceOf([]));
    expect(none).toEqual([expect.objectContaining({ status: "FAIL", detail: expect.stringContaining("no serial ports under /dev/serial/by-id") })]);
  });

  it("K16: two boards flashed with the same id fail, naming both ports", async () => {
    const clock = new FakeClock();
    const a = new SimulatedHand(new SimulatedPort("port-a"), "hand-left-01", clock);
    const b = new SimulatedHand(new SimulatedPort("port-b"), "hand-left-01", clock);
    const lines = await check(clock, ctxFor(clock, { expect: ["hand-left-01"] }), sourceOf([a, b].map((board) => ({ port: board.port, board }))));
    expect(byItem(lines)["hand-left-01"]).toBe("FAIL two boards say they are hand-left-01: port-a and port-b. Reflash one (scripts/flash-esp32.sh)");
  });

  it("K17: every zone invalid warns; a perception board that sends no zones fails", async () => {
    const clock = new FakeClock();
    const tof = new SimulatedTof(new SimulatedPort("tof"), "tof-front-01", clock);
    tof.readings = { front_left: "invalid", front_right: "invalid" };
    const warned = byItem(await check(clock, ctxFor(clock, { expect: ["tof-front-01"] }), sourceOf([{ port: tof.port, board: tof }])));
    expect(warned["tof-front-01 zones"]).toMatch(/^WARN front_left - invalid, front_right - invalid; \d+ reports .*every zone invalid/);

    // A board that answers hello as a perception module and then says nothing more.
    const quiet = new SimulatedPort("quiet");
    quiet.onPiLine = (line) => {
      if (line.includes("hello.request")) {
        quiet.sendLine({ v: 1, type: "hello", module_id: "tof-front-01", seq: 0, module_type: "perception", capabilities: ["zones"], firmware_version: "0.1.0", uptime_ms: 5 });
      }
    };
    const failed = byItem(await check(clock, ctxFor(clock, { expect: ["tof-front-01"] }), sourceOf([{ port: quiet }])));
    expect(failed["tof-front-01 zones"]).toBe("FAIL no zone report in 1.2 s");
  });

  it("K18: --press prompts for each hand and reports the button as the Pi maps it; no press fails", async () => {
    const clock = new FakeClock();
    const w = walker(clock);
    const ctx = ctxFor(clock, { press: true });
    // The left wait starts after the hellos and the sample (about 1.3 s); the right one after the left press.
    clock.setTimeout(() => w.left.press("talk", "pressed"), 3000);
    clock.setTimeout(() => w.right.press("talk", "pressed"), 6000);
    const items = byItem(await check(clock, ctx, sourceOf(w.boards)));
    expect(items["hand-left-01 press"]).toMatch(/^PASS pressed after 1\.\d s: the board said "talk", the Pi reads it as Confirm$/);
    expect(items["hand-right-01 press"]).toMatch(/^PASS pressed after 3\.\d s: the board said "talk", the Pi reads it as Talk$/);
    expect(ctx.said).toEqual([
      `Press a button on the left hand (hand-left-01) now. Waiting ${PRESS_WAIT_MS / 1000} s...`,
      `Press a button on the right hand (hand-right-01) now. Waiting ${PRESS_WAIT_MS / 1000} s...`,
    ]);

    const clock2 = new FakeClock();
    const w2 = walker(clock2);
    const timedOut = byItem(await check(clock2, ctxFor(clock2, { press: true }), sourceOf(w2.boards), 40_000));
    expect(timedOut["hand-left-01 press"]).toBe(`FAIL no press within ${PRESS_WAIT_MS / 1000} s`);
  });

  it("K19: --buzz sends exactly one short Talk-press buzz to each hand and reports its ack", async () => {
    const clock = new FakeClock();
    const w = walker(clock);
    const felt: string[] = [];
    w.left.onHaptic = (pattern, ms) => felt.push(`left ${pattern} ${ms}`);
    w.right.onHaptic = (pattern, ms) => felt.push(`right ${pattern} ${ms}`);
    const items = byItem(await check(clock, ctxFor(clock, { buzz: true }), sourceOf(w.boards)));
    expect(felt).toEqual(["left recording 300", "right recording 300"]);
    expect(items["hand-left-01 buzz"]).toBe("PASS recording 300 ms accepted: feel for one buzz on that hand");
    for (const board of [w.left, w.right]) expect(hapticLines(board.port)).toHaveLength(1);
    expect(hapticLines(w.tof.port)).toEqual([]);
  });

  it("K15: with the service running, no port is opened; the modules come from its log", async () => {
    const clock = new FakeClock();
    const w = walker(clock);
    const source = sourceOf(w.boards);
    const calls: string[][] = [];
    const run: Runner = async (command, args) => {
      calls.push([command, ...args]);
      const log = 'module said hello module="hand-left-01" type="hand" firmware="0.1.0" simulated=false\nmodule said hello module="tof-front-01" type="perception" firmware=null simulated=false\n';
      return { code: 0, stdout: Buffer.from(log), stderr: "", missing: false, timedOut: false, ms: 3 };
    };
    const lines = await check(clock, ctxFor(clock, {}, { run, facts: { serviceActive: true } }), source);
    expect(source.opened).toEqual([]);
    expect(calls).toEqual([["journalctl", "-u", "steady-walker", "-b", "-o", "cat", "--no-pager", "-n", "5000"]]);
    expect(lines).toEqual([
      expect.objectContaining({
        status: "SKIP",
        detail: expect.stringContaining("hellos from hand-left-01 (hand, firmware 0.1.0), tof-front-01 (perception, firmware unknown)"),
      }),
    ]);
  });

  it("K22: --sim checks simulated boards, and says so on every module line", async () => {
    const clock = new FakeClock();
    const lines = await check(clock, ctxFor(clock, { sim: true, buzz: true, press: true }, { platform: "darwin" }), simulatedSerial(clock));
    const items = byItem(lines);
    for (const id of SIM_MODULES) expect(items[id]).toMatch(/^PASS .*\(simulated\)$/);
    expect(items["hand-left-sim press"]).toBe("SKIP simulated hands have no buttons to press");
    expect(items["hand-right-sim buzz"]).toBe("PASS recording 300 ms accepted (simulated)");
    expect(lines.filter((l) => l.status === "FAIL")).toEqual([]);
  });
});
