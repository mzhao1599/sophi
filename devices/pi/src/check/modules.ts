import type { SerialMessage } from "@walker/contracts";
import { Bus } from "../bus";
import type { Clock } from "../clock";
import { TALK_PRESS_HAPTIC_MS } from "../constants";
import { silentLogger } from "../log";
import { LineReader } from "../serial/lineReader";
import { ModuleManager, canBuzz, type ModuleView, type SerialConnection } from "../serial/modules";
import { SERIAL_BY_ID_DIR, listSerialPorts, openSerialPort } from "../serial/port";
import { SimulatedHand, SimulatedPort, SimulatedTof } from "../sim/fakeModules";
import { NOT_A_PI, commandProblem, fail, isLinux, pass, skip, text, warn, type Check, type CheckContext, type CheckLine } from "./core";
import { SERVICE_UNIT } from "./system";

/** The modules the demo walker has. `--expect` replaces the list. */
export const EXPECTED_MODULES = ["hand-left-01", "hand-right-01", "tof-front-01"];
export const SIM_MODULES = ["hand-left-sim", "hand-right-sim", "tof-front-sim"];

/** Placeholders, not measured: a board answers hello.request at once, and heartbeats come every second. */
export const HELLO_WAIT_MS = 3000;
/** After the hellos, this long for a heartbeat (health and faults) and a sample of zone reports. */
export const SAMPLE_MS = 1200;
export const PRESS_WAIT_MS = 10_000;
export const ACK_WAIT_MS = 1000;

/** Where the serial check gets its ports: real ttys (the service's own code) or simulated boards. */
export interface SerialSource {
  simulated: boolean;
  ports(ctx: CheckContext): string[];
  open(path: string): SerialConnection;
  /** Called once every port is attached (the simulated boards boot here). */
  started?(): void;
  stop?(): void;
}

export const realSerial: SerialSource = {
  simulated: false,
  ports: (ctx) => ctx.options.ports ?? listSerialPorts(ctx.env.WALKER_SERIAL_DIR || SERIAL_BY_ID_DIR),
  open: (path) => openSerialPort(path, silentLogger),
};

/** `--sim`: two simulated hands and a simulated ToF board, speaking serial v1 through the same module manager. */
export function simulatedSerial(clock: Clock): SerialSource {
  const ports = new Map<string, SimulatedPort>();
  const boards: Array<SimulatedHand | SimulatedTof> = [];
  for (const id of SIM_MODULES) {
    const port = new SimulatedPort(`sim:${id}`);
    ports.set(port.id, port);
    boards.push(id.startsWith("tof") ? new SimulatedTof(port, id, clock) : new SimulatedHand(port, id, clock));
  }
  return {
    simulated: true,
    ports: () => [...ports.keys()],
    open: (path) => ports.get(path)!,
    started: () => boards.forEach((board) => board.start()),
    stop: () => boards.forEach((board) => board.hang()),
  };
}

interface Tap {
  conn: SerialConnection;
  hellos: Array<Extract<SerialMessage, { type: "hello" }>>;
  lines: number;
  refused: number;
  zoneReports: number;
  lastZones: Array<{ name: string; mm: number | null; quality: string }>;
  acks: Map<string, { result: string; reason?: string }>;
  lastHapticRequest: string | null;
  lastPressRaw: string | null;
}

/** Watches one port's traffic with its own line reader, alongside the module manager. */
function tap(conn: SerialConnection): { tapped: SerialConnection; state: Tap } {
  const state: Tap = { conn, hellos: [], lines: 0, refused: 0, zoneReports: 0, lastZones: [], acks: new Map(), lastHapticRequest: null, lastPressRaw: null };
  const reader = new LineReader((result) => {
    state.lines += 1;
    if (!result.ok) {
      state.refused += 1;
      return;
    }
    const message = result.message;
    if (message.type === "hello") state.hellos.push(message);
    else if (message.type === "perception.zones") {
      state.zoneReports += 1;
      state.lastZones = message.zones.map((z) => ({ name: z.name, mm: z.mm, quality: z.quality }));
    } else if (message.type === "ack") state.acks.set(message.request_id, { result: message.result, ...(message.reason ? { reason: message.reason } : {}) });
    else if (message.type === "hand.input" && message.edge === "pressed" && message.button) state.lastPressRaw = message.button;
  });
  const tapped: SerialConnection = {
    id: conn.id,
    simulated: conn.simulated,
    write(line) {
      const ok = conn.write(line);
      if (ok && line.includes('"haptic.play"')) state.lastHapticRequest = (JSON.parse(line) as { request_id: string }).request_id;
      return ok;
    },
    onData: (fn) =>
      conn.onData((data) => {
        fn(data);
        reader.push(data);
      }),
    onClose: (fn) => conn.onClose(fn),
    close: () => conn.close(),
  };
  return { tapped, state };
}

async function waitUntil(clock: Clock, ms: number, done: () => boolean): Promise<void> {
  const start = clock.monotonic();
  while (!done() && clock.monotonic() - start < ms) await new Promise<void>((resolve) => clock.setTimeout(resolve, 50));
}

/** With the service running: the modules its log says hello from since boot (it holds the ports). */
export async function serviceLogLine(ctx: CheckContext): Promise<CheckLine> {
  const reason = `${SERVICE_UNIT} is running and holds the serial ports. For a live check: sudo systemctl stop ${SERVICE_UNIT}, run this again, then start it`;
  const result = await ctx.run("journalctl", ["-u", SERVICE_UNIT, "-b", "-o", "cat", "--no-pager", "-n", "5000"]);
  const problem = commandProblem("journalctl", result);
  if (problem) return skip("serial", "modules", `${reason}. (Couldn't read its log: ${problem})`);
  const seen = new Map<string, string>();
  for (const line of text(result).split("\n")) {
    const match = /module said hello module="([^"]+)" type="([^"]+)" firmware=(?:"([^"]*)"|null)/.exec(line);
    if (match) seen.set(match[1]!, `${match[1]} (${match[2]}, firmware ${match[3] ?? "unknown"})`);
  }
  const heard = seen.size ? `Its log since boot has hellos from ${[...seen.values()].join(", ")}` : "Its log since boot has no module hello";
  return skip("serial", "modules", `${reason}. ${heard}`);
}

function moduleDetail(view: ModuleView, state: Tap): string {
  const hello = state.hellos.at(-1);
  const faults = view.faults.length ? `, faults ${view.faults.join(" ")}` : "";
  return `${view.type}, firmware ${view.firmwareVersion ?? "unknown"}, protocol v${hello?.v ?? "?"}, health ${view.health}${faults}, ` +
    `can ${view.capabilities.join(" ")}, port ${state.conn.id}${view.simulated ? " (simulated)" : ""}`;
}

function sideOf(id: string): string {
  return id.startsWith("hand-left-") ? "left" : id.startsWith("hand-right-") ? "right" : id;
}

export async function moduleLines(ctx: CheckContext, source: SerialSource): Promise<CheckLine[]> {
  if (!source.simulated && ctx.facts.serviceActive) return [await serviceLogLine(ctx)];
  if (!source.simulated && !isLinux(ctx) && !ctx.options.ports) {
    return [skip("serial", "modules", `${NOT_A_PI(ctx)}; pass --sim for simulated boards, or --port <tty> for a board on this computer`)];
  }
  const paths = source.ports(ctx);
  if (paths.length === 0) {
    return [fail("serial", "modules", `no serial ports under ${ctx.env.WALKER_SERIAL_DIR || SERIAL_BY_ID_DIR}: plug the boards in with data cables (check lsusb)`)];
  }
  const sim = source.simulated ? " (simulated)" : "";
  const bus = new Bus();
  const modules = new ModuleManager({ clock: ctx.clock, log: silentLogger, bus });
  const lines: CheckLine[] = [];
  const taps: Tap[] = [];
  try {
    for (const path of paths) {
      let conn: SerialConnection;
      try {
        conn = source.open(path);
      } catch (error) {
        lines.push(fail("serial", path.split("/").at(-1)!, `couldn't open: ${(error as Error).message}`));
        continue;
      }
      const { tapped, state } = tap(conn);
      taps.push(state);
      modules.attach(tapped);
    }
    source.started?.();
    await waitUntil(ctx.clock, HELLO_WAIT_MS, () => taps.every((t) => t.hellos.length > 0));
    await new Promise<void>((resolve) => ctx.clock.setTimeout(resolve, SAMPLE_MS));

    // One line per port: its module, or why there is none.
    const ports = new Map<string, Tap[]>();
    for (const state of taps) {
      const id = state.hellos.at(-1)?.module_id;
      if (!id) {
        lines.push(fail("serial", "port", `no hello within ${HELLO_WAIT_MS / 1000} s on ${state.conn.id} (${state.lines} lines read, ${state.refused} unreadable): not our firmware, or the board is stuck in its bootloader`));
        continue;
      }
      ports.set(id, [...(ports.get(id) ?? []), state]);
    }
    const views = new Map(modules.modules().map((view) => [view.instanceId, view]));
    for (const [id, states] of [...ports].sort(([a], [b]) => a.localeCompare(b))) {
      if (states.length > 1) {
        lines.push(fail("serial", id, `two boards say they are ${id}: ${states.map((s) => s.conn.id).join(" and ")}. Reflash one (scripts/flash-esp32.sh)`));
        continue;
      }
      const view = views.get(id);
      const state = states[0]!;
      if (!view) {
        lines.push(fail("serial", id, `said hello on ${state.conn.id} but isn't registered`));
        continue;
      }
      const detail = moduleDetail(view, state);
      lines.push(view.health === "ok" ? pass("serial", id, detail) : view.health === "degraded" ? warn("serial", id, detail) : fail("serial", id, detail));
      if (view.type === "perception") {
        if (state.zoneReports === 0) lines.push(fail("serial", `${id} zones`, `no zone report in ${SAMPLE_MS / 1000} s${sim}`));
        else {
          const zones = state.lastZones.map((z) => `${z.name} ${z.mm === null ? "-" : `${z.mm} mm`} ${z.quality}`).join(", ");
          const detail = `${zones}; ${state.zoneReports} reports in ${(SAMPLE_MS / 1000).toFixed(1)} s${sim}`;
          lines.push(state.lastZones.some((z) => z.quality === "valid") ? pass("serial", `${id} zones`, detail) : warn("serial", `${id} zones`, `${detail}: every zone invalid (nothing in range, or sensors missing)`));
        }
      }
    }
    const expected = ctx.options.expect.length ? ctx.options.expect : source.simulated ? SIM_MODULES : EXPECTED_MODULES;
    for (const id of expected) {
      if (!ports.has(id)) lines.push(fail("serial", id, `not seen on any port${id.startsWith("hand-right") ? " (not flashed yet? scripts/flash-esp32.sh hand-right-01)" : ""}`));
    }

    const hands = [...ports.keys()].filter((id) => ports.get(id)!.length === 1 && views.get(id)?.type === "hand").sort();
    for (const id of hands) {
      const state = ports.get(id)![0]!;
      const item = `${id} press`;
      if (!ctx.options.press) {
        lines.push(skip("serial", item, "pass --press to check its buttons"));
        continue;
      }
      if (source.simulated) {
        lines.push(skip("serial", item, "simulated hands have no buttons to press"));
        continue;
      }
      ctx.say(`Press a button on the ${sideOf(id)} hand (${id}) now. Waiting ${PRESS_WAIT_MS / 1000} s...`);
      let pressed: string | null = null;
      const off = bus.on("button", (event) => {
        if (event.edge === "pressed" && event.detail === id && pressed === null) pressed = event.button;
      });
      const start = ctx.clock.monotonic();
      await waitUntil(ctx.clock, PRESS_WAIT_MS, () => pressed !== null);
      off();
      const seconds = ((ctx.clock.monotonic() - start) / 1000).toFixed(1);
      lines.push(
        pressed === null
          ? fail("serial", item, `no press within ${PRESS_WAIT_MS / 1000} s`)
          : pass("serial", item, `pressed after ${seconds} s: the board said "${state.lastPressRaw}", the Pi reads it as ${pressed === "confirm" ? "Confirm" : "Talk"}`),
      );
    }

    for (const id of hands) {
      const item = `${id} buzz`;
      if (!ctx.options.buzz) continue;
      const view = views.get(id)!;
      const state = ports.get(id)![0]!;
      if (!canBuzz(view)) {
        const why = !view.capabilities.includes("haptic") ? "no haptic in its hello (driver not found at boot)" : `health ${view.health}${view.faults.length ? `, ${view.faults.join(" ")}` : ""}`;
        lines.push(fail("serial", item, `can't buzz: ${why}`));
        continue;
      }
      // One short buzz: the Talk-press pattern, the same command the service sends on a Talk press.
      if (!modules.sendHaptic(id, "recording", TALK_PRESS_HAPTIC_MS)) {
        lines.push(fail("serial", item, "not sent (port busy)"));
        continue;
      }
      const request = state.lastHapticRequest;
      await waitUntil(ctx.clock, ACK_WAIT_MS, () => request !== null && state.acks.has(request));
      const ack = request ? state.acks.get(request) : undefined;
      lines.push(
        !ack
          ? fail("serial", item, `sent recording ${TALK_PRESS_HAPTIC_MS} ms, no ack within ${ACK_WAIT_MS / 1000} s`)
          : ack.result === "accepted"
            ? pass("serial", item, `recording ${TALK_PRESS_HAPTIC_MS} ms accepted${sim}${source.simulated ? "" : ": feel for one buzz on that hand"}`)
            : fail("serial", item, `rejected: ${ack.reason ?? "no reason"}`),
      );
    }
    return lines;
  } finally {
    source.stop?.();
    modules.stop();
  }
}

export function serialCheck(source: SerialSource): Check {
  // Hellos, a sample, then up to two presses and two buzzes.
  return { name: "serial", timeoutMs: HELLO_WAIT_MS + SAMPLE_MS + 2 * PRESS_WAIT_MS + 2 * ACK_WAIT_MS + 10_000, run: (ctx) => moduleLines(ctx, source) };
}
