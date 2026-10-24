import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScreenStateName } from "@walker/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startWalkerScreen, type WalkerScreen } from "../src/screen";
import { SIM_TRAY_HEIGHT_MM } from "../src/sim/liftSim";
import { makeMotionHarness, type MotionHarness } from "./support/motion";

/**
 * Row E11 of test/EXPECTED.md: the lift's hold control end to end. The real walker screen (its state machine
 * and its server on a real socket on 127.0.0.1) beside the real motion coordinator, the real lift client and
 * the SIMULATED lift board and servos, on a fake clock. This test plays the page: it opens the screen's stream
 * and posts the hold control's "still held" every 50 ms of the Pi's clock, as src/screen/hold.ts does, and lets
 * go the way the page would. The Pi stamps each one on receipt, so the fake clock decides freshness.
 */

function assets(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "walker-lift-screen-")), "screen-page");
  mkdirSync(dir);
  writeFileSync(join(dir, "page.js"), "/* page */");
  writeFileSync(join(dir, "page.css"), "/* css */");
  writeFileSync(join(dir, "OFL.txt"), "licence");
  return dir;
}

function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { Host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

let harness: MotionHarness | null = null;
let screen: WalkerScreen | null = null;
let socket: Socket | null = null;
afterEach(async () => {
  socket?.destroy();
  await screen?.stop();
  if (harness) {
    expect(harness.invalid).toEqual([]);
    await harness.stop();
  }
  harness = null;
  screen = null;
  socket = null;
});

async function setUp() {
  const h = makeMotionHarness({ lift: true });
  harness = h;
  const events: string[] = [];
  h.bus.on("motion", ({ kind, text }) => events.push(`${kind} ${text}`));
  let shown: ScreenStateName | null = null;
  h.bus.on("screen", ({ state }) => (shown = state));
  const holds: string[] = [];
  h.bus.on("screenHold", (hold) => holds.push(hold.pressed ? "held" : hold.reason));
  await h.start();
  screen = await startWalkerScreen({
    bus: h.bus,
    clock: h.clock,
    log: h.log,
    service: h.service,
    modules: h.modules,
    simulator: true,
    port: 0,
    assetsDir: assets(),
    localTime: () => null,
  });
  const port = Number(new URL(screen.url!).port);
  const page = await call(port, "/");
  const token = /<meta name="screen-token" content="([^"]+)">/.exec(page.body)![1]!;
  // The page's stream: the server counts a hold only while a screen is watching.
  socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket!.once("connect", () => resolve()));
  socket.write(`GET /screen/events?token=${token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  await new Promise((r) => setTimeout(r, 50));
  let pageClock = 1;
  const post = (pressed: boolean) =>
    call(port, "/screen/hold", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Screen-Token": token },
      body: JSON.stringify({ pressed, at: (pageClock += 1) }),
    });
  let holding = false;
  let lastStatus = 0;
  const t = {
    h,
    events,
    holds,
    get shown() {
      return shown;
    },
    get lastStatus() {
      return lastStatus;
    },
    key: (name: string) => h.press(name),
    hold: async (on: boolean) => {
      holding = on;
      lastStatus = (await post(on)).status;
    },
    /** 10 ms steps of the Pi's clock; while held, "still held" every 50 ms (HOLD_SEND_MS), as the page sends it. */
    async wait(ms: number) {
      const end = h.clock.monotonic() + ms;
      while (h.clock.monotonic() < end) {
        if (holding && h.clock.monotonic() % 50 === 0) lastStatus = (await post(true)).status;
        await h.clock.advance(10);
      }
    },
    async until(pred: () => boolean, maxMs: number) {
      const end = h.clock.monotonic() + maxMs;
      while (!pred() && h.clock.monotonic() < end) await t.wait(10);
      return pred();
    },
    saw: (text: string) => events.some((e) => e.includes(text)),
    lift: () => h.coordinator.state().lift!,
    async confirm(key: string) {
      t.key(key);
      await t.wait(2100);
      t.key("c");
    },
  };
  // Motors on (the SIMULATED arms start folded), then home it, held on the screen.
  for (const side of ["left", "right"]) {
    await t.confirm(`torque-on-${side}`);
    expect(await t.until(() => t.saw(`torque ${side} on`), 3000)).toBe(true);
  }
  t.key("lift-home");
  await t.wait(10);
  expect(t.shown).toBe("motion_confirm");
  await t.hold(true);
  expect(t.lastStatus).toBe(204);
  await t.wait(2100);
  t.key("c");
  expect(await t.until(() => t.saw("lift ended lift.home"), 40_000)).toBe(true);
  expect(t.saw("lift ended lift.home completed")).toBe(true);
  await t.hold(false);
  await t.wait(100);
  return t;
}

describe("E11: the lift's hold control on the walker screen, end to end", () => {
  it("the target shows the hold control; holding it and pressing Confirm raises the lift; letting go stops it for good", async () => {
    const t = await setUp();
    t.key("lift-up");
    await t.wait(10);
    expect(t.shown).toBe("motion_confirm");
    await t.hold(true);
    await t.wait(2100);
    t.key("c");
    await t.wait(100);
    expect(t.shown).toBe("motion_running");
    expect(t.h.coordinator.state().active).toMatchObject({ kind: "lift.move", phase: "running", hold_source: "screen_hold_control" });
    expect(await t.until(() => (t.lift().position_mm ?? 0) >= 100, 30_000)).toBe(true);
    expect(t.lastStatus).toBe(204);
    // Her finger lifts: the page posts the release once.
    await t.hold(false);
    expect(t.h.coordinator.state().active).toMatchObject({ kind: "lift.move" });
    expect(await t.until(() => t.saw("lift ended lift.move"), 2000)).toBe(true);
    expect(t.saw("lift ended lift.move stopped")).toBe(true);
    await t.wait(100);
    expect(t.h.coordinator.state()).toMatchObject({ mode: "ready", active: null, last_command: { kind: "lift.move", outcome: "stopped" } });
    expect(t.shown).toBe("motion_holding");
    const at = t.lift().position_mm!;
    expect(at).toBeLessThan(SIM_TRAY_HEIGHT_MM);
    // Pressing the control again moves nothing: that request never resumes, and there is no control on screen.
    await t.hold(true);
    expect(t.lastStatus).toBe(409);
    await t.wait(500);
    expect(t.lift().position_mm).toBeCloseTo(at, 6);
  }, 120_000);

  it("an obstacle taking the screen mid-move: the next still-held is refused (409, a release) and the lift stops", async () => {
    const t = await setUp();
    t.key("lift-up");
    await t.hold(true);
    await t.wait(2100);
    t.key("c");
    expect(await t.until(() => (t.lift().position_mm ?? 0) >= 50, 30_000)).toBe(true);
    const now = t.h.clock.monotonic();
    t.h.bus.emit("zones", { zones: [{ zone: "front_left", instanceId: "tof-front-sim", mm: 300, quality: "valid", receivedMono: now, receivedWall: t.h.clock.now() }] });
    await t.wait(10);
    expect(t.shown).toBe("obstacle");
    await t.wait(60);
    expect(t.lastStatus).toBe(409);
    expect(t.holds.at(-1)).toBe("not_shown");
    expect(await t.until(() => t.saw("lift ended lift.move"), 2000)).toBe(true);
    expect(t.saw("lift ended lift.move stopped")).toBe(true);
  }, 120_000);

  it("Talk with a lift target pending and the control held: the target is withdrawn, the hold refused, and Confirm then starts nothing", async () => {
    const t = await setUp();
    t.key("lift-up");
    await t.hold(true);
    await t.wait(1000);
    t.key("t");
    await t.wait(60);
    expect(t.saw("target-ended withdrawn: Talk pressed")).toBe(true);
    expect(t.shown).not.toBe("motion_confirm");
    expect(t.lastStatus).toBe(409);
    expect(t.holds.at(-1)).toBe("not_shown");
    await t.wait(1500);
    t.key("c");
    await t.wait(500);
    expect(t.h.coordinator.state().active).toBeNull();
    expect(t.lift().position_mm).toBeCloseTo(5, 1);
  }, 120_000);

  it("Talk while the lift runs is a handle press: it stops the lift", async () => {
    const t = await setUp();
    t.key("lift-up");
    await t.hold(true);
    await t.wait(2100);
    t.key("c");
    expect(await t.until(() => (t.lift().position_mm ?? 0) >= 50, 30_000)).toBe(true);
    t.key("t");
    expect(t.saw("stop handle_press")).toBe(true);
    expect(await t.until(() => t.saw("lift ended lift.move"), 2000)).toBe(true);
    expect(t.saw("lift ended lift.move stopped")).toBe(true);
  }, 120_000);
});
