import { LiftStatusSchema, parseLiftSerialLine, type LiftSerialMessage } from "@walker/contracts";
import { describe, expect, it } from "vitest";
import { SIM_LIFT_FROZEN_RESTART_MS, SIM_LIFT_PREFIXES, SimulatedLiftBoard, type SimulatedLiftBoardOptions } from "../src/sim/fakeLift";
import { SimulatedPort } from "../src/sim/fakeModules";
import { FakeClock, captureLogger, flush } from "./support/fakes";

// ---- The simulated lift on its own, driven line by line (LF) ----

function board(options: SimulatedLiftBoardOptions = {}) {
  const clock = new FakeClock();
  const port = new SimulatedPort("sim:lift");
  const lift = new SimulatedLiftBoard(port, clock, options);
  const out: LiftSerialMessage[] = [];
  const bad: string[] = [];
  port.onData((data) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      const parsed = parseLiftSerialLine(line);
      if (parsed.ok) out.push(parsed.message);
      else bad.push(`${parsed.problem}: ${line}`);
    }
  });
  let seq = 1;
  let hold: string | null = null;
  let beating = false;
  const send = (m: Record<string, unknown>, at = seq++) => port.write(`${JSON.stringify({ v: 1, module_id: "lift-01", seq: at, ...m })}\n`);
  const beat = () => {
    if (beating) send({ type: "lift.heartbeat", hold_request_id: hold });
    clock.setTimeout(beat, 100);
  };
  clock.setTimeout(beat, 100);
  lift.start();
  const b = {
    clock,
    lift,
    port,
    out,
    bad,
    send,
    get seq() {
      return seq;
    },
    async pi(m: Record<string, unknown>) {
      send(m);
      await flush();
    },
    beats(on: boolean, holdId: string | null = hold) {
      beating = on;
      hold = holdId;
    },
    hold(id: string | null) {
      hold = id;
    },
    ack(id: string) {
      return out.filter((m) => m.type === "lift.ack" && m.request_id === id).at(-1) as Extract<LiftSerialMessage, { type: "lift.ack" }> | undefined;
    },
    done(id: string) {
      return out.find((m) => m.type === "lift.done" && m.request_id === id) as Extract<LiftSerialMessage, { type: "lift.done" }> | undefined;
    },
    status() {
      return out.filter((m) => m.type === "lift.status").at(-1) as Extract<LiftSerialMessage, { type: "lift.status" }>;
    },
    async until(pred: () => boolean, maxMs: number) {
      for (let t = 0; t < maxMs && !pred(); t += 10) await clock.advance(10);
      return pred();
    },
    /** Holds a homing under `id` until it completes. */
    async home(id: string) {
      b.beats(true, id);
      await clock.advance(100);
      await b.pi({ type: "lift.home", request_id: id });
      expect(b.ack(id)?.result).toBe("accepted");
      expect(await b.until(() => b.done(id) !== undefined, 30_000)).toBe(true);
      expect(b.done(id)?.outcome).toBe("completed");
    },
  };
  return b;
}

describe("simulated lift: rules 1 to 10", () => {
  it("LF1: boots with lift.hello seq 0, then an unhomed status with the driver enabled; status at 20 Hz; every line parses", async () => {
    const b = board();
    await flush();
    expect(b.out[0]).toMatchObject({ type: "lift.hello", seq: 0, config: b.lift.config, stop_sense: "wired" });
    expect(b.out[1]).toMatchObject({ type: "lift.status", state: "unhomed", homed: false, driver_enabled: true, heartbeat_age_ms: null });
    const before = b.out.filter((m) => m.type === "lift.status").length;
    await b.clock.advance(1000);
    const statuses = b.out.filter((m) => m.type === "lift.status").length - before;
    expect(statuses).toBeGreaterThanOrEqual(19);
    expect(statuses).toBeLessThanOrEqual(21);
    expect(b.bad).toEqual([]);
  });

  it("LF1: homing runs the four phases and ends homed at 5 mm, the counted height matching the carriage", async () => {
    const b = board({ startHeightMm: 40 });
    await b.home("abc123-1");
    expect(b.done("abc123-1")?.position_mm).toBeCloseTo(5, 1); // one 10 ms sample under 5 mm, as the firmware
    expect(b.status()).toMatchObject({ state: "idle", homed: true });
    expect(b.lift.inspect().physicalMm).toBeCloseTo(5, 0);
    const phases = b.out.filter((m) => m.type === "lift.status" && m.state === "homing").map((m) => (m as { target_mm: number | null }).target_mm);
    expect(phases).toContain(5); // the final back-off's end is reported while below it
    for (const m of b.out) if (m.type === "lift.status") expect(LiftStatusSchema.safeParse(m).success).toBe(true);
    expect(b.bad).toEqual([]);
  });

  it("LF1: rule 4's refusals, in order", async () => {
    const b = board({ startHeightMm: 40 });
    await b.pi({ type: "lift.home", request_id: "abc123-1" });
    expect(b.ack("abc123-1")?.reason).toBe("no_heartbeat");
    b.beats(true, null);
    await b.clock.advance(150);
    await b.pi({ type: "lift.home", request_id: "abc123-2" });
    expect(b.ack("abc123-2")?.reason).toBe("not_held");
    await b.pi({ type: "lift.move", request_id: "abc123-3", target_mm: 100, speed_mm_s: 10 });
    expect(b.ack("abc123-3")?.reason).toBe("not_held");
    b.hold("abc123-4");
    await b.clock.advance(150);
    await b.pi({ type: "lift.move", request_id: "abc123-4", target_mm: 100, speed_mm_s: 10 });
    expect(b.ack("abc123-4")?.reason).toBe("not_homed");
    b.lift.stopPressed = true;
    b.hold("abc123-5");
    await b.clock.advance(150);
    await b.pi({ type: "lift.home", request_id: "abc123-5" });
    expect(b.ack("abc123-5")?.reason).toBe("stop_pressed");
    b.lift.stopPressed = false;
    b.hold("abc123-6");
    await b.clock.advance(150);
    await b.pi({ type: "lift.home", request_id: "abc123-6" });
    expect(b.ack("abc123-6")?.reason).toBe("fault_latched");
    await b.pi({ type: "lift.clear", request_id: "abc123-7" });
    expect(b.ack("abc123-7")?.result).toBe("accepted");
    await b.home("abc123-8");
    // Used: an id at or below the highest accepted under this prefix.
    b.hold("abc123-8");
    await b.clock.advance(150);
    await b.pi({ type: "lift.move", request_id: "abc123-8", target_mm: 100, speed_mm_s: 10 });
    expect(b.ack("abc123-8")?.reason).toBe("request_used");
    b.hold("abc123-9");
    await b.clock.advance(150);
    await b.pi({ type: "lift.move", request_id: "abc123-9", target_mm: 601, speed_mm_s: 10 });
    expect(b.ack("abc123-9")?.reason).toBe("out_of_range");
    await b.pi({ type: "lift.move", request_id: "abc123-10", target_mm: 100, speed_mm_s: 10 });
    expect(b.ack("abc123-10")?.reason).toBe("not_held");
  });

  it("LF1: rule 3: a stale heartbeat is ignored, a stale command rejected stale_seq, a stale stop accepted", async () => {
    const b = board();
    b.send({ type: "lift.heartbeat", hold_request_id: "abc123-1" }, 50);
    b.send({ type: "lift.heartbeat", hold_request_id: null }, 40); // stale: the hold stays abc123-1
    await flush();
    b.send({ type: "lift.home", request_id: "abc123-1" }, 51);
    await flush();
    expect(b.ack("abc123-1")?.result).toBe("accepted");
    b.send({ type: "lift.clear", request_id: "abc123-2" }, 10);
    b.send({ type: "lift.stop", request_id: "abc123-3" }, 11);
    await flush();
    expect(b.ack("abc123-2")?.reason).toBe("stale_seq");
    expect(b.ack("abc123-3")?.result).toBe("accepted");
  });

  it("LF1: rules 2 and 5: hello.request, letting go and the watchdog each stop a move; only the watchdog latches", async () => {
    const b = board({ startHeightMm: 10 });
    await b.home("abc123-1");
    const move = async (id: string) => {
      b.beats(true, id);
      await b.clock.advance(100);
      await b.pi({ type: "lift.move", request_id: id, target_mm: 300, speed_mm_s: 20 });
      expect(b.ack(id)?.result).toBe("accepted");
      await b.clock.advance(1000);
    };
    await move("abc123-2");
    await b.pi({ type: "hello.request", module_id: "any" });
    expect(await b.until(() => b.done("abc123-2") !== undefined, 2000)).toBe(true);
    expect(b.done("abc123-2")?.outcome).toBe("stopped");
    expect(b.out.filter((m) => m.type === "lift.hello")).toHaveLength(2);
    await move("abc123-3");
    b.hold(null);
    expect(await b.until(() => b.done("abc123-3") !== undefined, 2000)).toBe(true);
    expect(b.done("abc123-3")).toMatchObject({ outcome: "stopped" });
    expect(b.status()).toMatchObject({ homed: true, faults: [] });
    // A stopped request never resumes, whatever later heartbeats name.
    b.hold("abc123-3");
    const at = b.lift.inspect().countedMm;
    await b.clock.advance(500);
    expect(b.lift.inspect().countedMm).toBeCloseTo(at, 6);
    await move("abc123-4");
    b.beats(false);
    const stoppedAt = b.clock.monotonic();
    expect(await b.until(() => b.done("abc123-4") !== undefined, 2000)).toBe(true);
    expect(b.clock.monotonic() - stoppedAt).toBeLessThanOrEqual(300 + 100 + 150);
    expect(b.done("abc123-4")).toMatchObject({ outcome: "failed", fault: "watchdog_expired" });
    expect(b.status()).toMatchObject({ state: "fault", homed: false, driver_enabled: true, faults: ["watchdog_expired"] });
  });

  it("LF1: rule 8: the stop, a stuck switch while homed, and a cut harness each latch and unhome", async () => {
    const b = board({ startHeightMm: 10 });
    await b.home("abc123-1");
    b.lift.switchFaults.bottom = "stuck_pressed";
    await b.clock.advance(50);
    expect(b.status()).toMatchObject({ state: "fault", homed: false, faults: ["limit_hit"] });
    b.lift.cutWire("both");
    await b.clock.advance(50);
    expect(b.status().faults).toEqual(expect.arrayContaining(["limit_hit", "limit_wiring"]));
    b.lift.switchFaults = { bottom: "ok", top: "ok" };
    b.lift.stopPressed = true;
    await b.clock.advance(50);
    expect(b.status()).toMatchObject({ stop_sense: "pressed" });
    expect(b.status().faults).toContain("stop_circuit_opened");
    // Rule 9: not while the stop is pressed; then yes, and still unhomed.
    b.beats(true, null);
    await b.clock.advance(150);
    await b.pi({ type: "lift.clear", request_id: "abc123-2" });
    expect(b.ack("abc123-2")?.reason).toBe("cause_present");
    b.lift.stopPressed = false;
    await b.clock.advance(50);
    await b.pi({ type: "lift.clear", request_id: "abc123-3" });
    expect(b.ack("abc123-3")?.result).toBe("accepted");
    await b.clock.advance(60);
    expect(b.status()).toMatchObject({ state: "unhomed", homed: false, faults: [] });
  });

  it("LF1: rule 6: disable off the bottom switch is refused disable_unsafe (driver on, a move ramps down); on the switch it frees the motor", async () => {
    const b = board({ startHeightMm: 10 });
    await b.home("abc123-1");
    b.beats(true, "abc123-2");
    await b.clock.advance(100);
    await b.pi({ type: "lift.move", request_id: "abc123-2", target_mm: 300, speed_mm_s: 20 });
    await b.clock.advance(500);
    await b.pi({ type: "lift.enable", request_id: "abc123-3", enabled: false });
    expect(b.ack("abc123-3")).toMatchObject({ result: "rejected", reason: "disable_unsafe" });
    expect(await b.until(() => b.done("abc123-2") !== undefined, 2000)).toBe(true);
    expect(b.done("abc123-2")?.outcome).toBe("stopped");
    expect(b.status()).toMatchObject({ driver_enabled: true, homed: true });

    const onSwitch = board({ startHeightMm: 0 });
    await flush();
    onSwitch.send({ type: "lift.enable", request_id: "abc123-1", enabled: false }, 1);
    await flush();
    expect(onSwitch.ack("abc123-1")?.result).toBe("accepted");
    await onSwitch.clock.advance(20);
    expect(onSwitch.status()).toMatchObject({ driver_enabled: false, homed: false });

    const safe = board({ startHeightMm: 10, disableSafe: true });
    await safe.pi({ type: "lift.enable", request_id: "abc123-1", enabled: false });
    expect(safe.ack("abc123-1")?.result).toBe("accepted");
  });

  it("LF1: after SIM_LIFT_PREFIXES boot prefixes, a new prefix is refused request_used until the lift restarts", async () => {
    const b = board({ startHeightMm: 40 });
    const prefix = (i: number) => `p${String(i).padStart(5, "0")}`;
    b.beats(true, null);
    for (let i = 0; i <= SIM_LIFT_PREFIXES; i += 1) {
      const id = `${prefix(i)}-1`;
      b.hold(id);
      await b.clock.advance(100);
      await b.pi({ type: "lift.home", request_id: id });
      if (i < SIM_LIFT_PREFIXES) {
        expect(b.ack(id)?.result, id).toBe("accepted");
        await b.pi({ type: "lift.stop", request_id: `${prefix(i)}-2` });
        expect(await b.until(() => b.done(id) !== undefined, 2000)).toBe(true);
      } else expect(b.ack(id)?.reason).toBe("request_used");
    }
  });

  it("LF2: a frozen board sends nothing, its motor finishes the move, and it restarts unhomed after 5 s", async () => {
    const b = board({ startHeightMm: 10 });
    await b.home("abc123-1");
    b.beats(true, "abc123-2");
    await b.clock.advance(100);
    await b.pi({ type: "lift.move", request_id: "abc123-2", target_mm: 40, speed_mm_s: 20 });
    await b.clock.advance(300);
    b.lift.freeze();
    const lines = b.out.length;
    await b.clock.advance(SIM_LIFT_FROZEN_RESTART_MS - 100);
    expect(b.out.length).toBe(lines);
    expect(b.lift.inspect().countedMm).toBeCloseTo(40, 3);
    await b.clock.advance(200);
    expect(b.out.slice(lines)[0]).toMatchObject({ type: "lift.hello", seq: 0 });
    expect(b.status()).toMatchObject({ state: "unhomed", homed: false });
  });
});

// The whole path (rows LW1 to LW5, LF2's lost line, frozen board and stalled loop) now runs under the real
// motion coordinator, with the arms: test/lift-coordinator.test.ts (rows E1 to E6) and test/sim/lift/*.walk.
