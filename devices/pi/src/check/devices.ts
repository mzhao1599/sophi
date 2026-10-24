import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arecordArgs } from "../audio/capture";
import { CUE_TONES, toneWav } from "../audio/wav";
import { MOTION_BENCH_ENV, MOTION_BENCH_ENV_VALUE } from "@walker/contracts";
import { CLIP_BYTES_PER_MS } from "../constants";
import { NOT_A_PI, commandProblem, fail, isLinux, pass, skip, text, warn, type Check, type CheckContext, type CheckLine } from "./core";
import { SERVICE_UNIT } from "./system";

// ---- audio ----

/** How much the microphone check records: 1 s, in memory only. */
export const MIC_TEST_MS = 1000;

/** Peak and RMS of 16-bit little-endian PCM. */
export function pcmLevel(pcm: Buffer): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let i = 0; i < samples; i += 1) {
    const value = pcm.readInt16LE(i * 2);
    peak = Math.max(peak, Math.abs(value));
    sum += value * value;
  }
  return { peak, rms: samples ? Math.round(Math.sqrt(sum / samples)) : 0 };
}

export async function micLine(ctx: CheckContext): Promise<CheckLine> {
  if (!isLinux(ctx)) return skip("audio", "microphone", NOT_A_PI(ctx));
  const device = ctx.env.WALKER_ALSA_CAPTURE;
  if (!device) return fail("audio", "microphone", "WALKER_ALSA_CAPTURE is not set (/etc/steady-walker.env)");
  // The service's own format, for 1 s. The audio stays in this process's memory and is zeroed below.
  const result = await ctx.run("arecord", [...arecordArgs(device), "-d", String(MIC_TEST_MS / 1000)], { timeoutMs: MIC_TEST_MS + 4000 });
  const pcm = result.stdout;
  try {
    const problem = commandProblem("arecord", result);
    if (problem) return fail("audio", "microphone", `${device}: ${problem}`);
    const { peak, rms } = pcmLevel(pcm);
    const seconds = (pcm.length / CLIP_BYTES_PER_MS / 1000).toFixed(1);
    if (pcm.length === 0) return fail("audio", "microphone", `${device}: recorded nothing`);
    if (peak === 0) return fail("audio", "microphone", `${device}: ${seconds} s recorded, every sample is 0 (muted? see amixer)`);
    return pass("audio", "microphone", `${device}: ${seconds} s recorded, peak ${peak} of 32767, RMS ${rms}`);
  } finally {
    pcm.fill(0);
  }
}

/** The device names `aplay -L` lists: its unindented lines. */
export function alsaNames(output: string): string[] {
  return output.split("\n").filter((line) => line !== "" && !/^\s/.test(line)).map((line) => line.trim());
}

export async function speakerLine(ctx: CheckContext): Promise<CheckLine> {
  if (!isLinux(ctx)) return skip("audio", "speaker", NOT_A_PI(ctx));
  const device = ctx.env.WALKER_ALSA_PLAYBACK;
  if (!device) return fail("audio", "speaker", "WALKER_ALSA_PLAYBACK is not set (/etc/steady-walker.env)");
  const result = await ctx.run("aplay", ["-L"]);
  const problem = commandProblem("aplay", result);
  if (problem) return fail("audio", "speaker", problem);
  const names = alsaNames(text(result));
  if (names.includes(device)) return pass("audio", "speaker", `${device} is listed by aplay -L`);
  const cards = [...new Set(names.map((n) => /CARD=([^,]+)/.exec(n)?.[1]).filter((c): c is string => !!c))];
  return fail("audio", "speaker", `${device} is not listed by aplay -L (cards: ${cards.join(", ") || "none"}). Is the soundbar plugged in?`);
}

export async function toneLine(ctx: CheckContext): Promise<CheckLine> {
  if (!isLinux(ctx)) return skip("audio", "test tone", NOT_A_PI(ctx));
  if (!ctx.options.sound) return skip("audio", "test tone", "pass --sound to play one short tone");
  const device = ctx.env.WALKER_ALSA_PLAYBACK;
  if (!device) return fail("audio", "test tone", "WALKER_ALSA_PLAYBACK is not set");
  const result = await ctx.run("aplay", ["-q", "-D", device, "-"], { input: toneWav(CUE_TONES.listening) });
  const problem = commandProblem("aplay", result);
  return problem
    ? fail("audio", "test tone", `${device}: ${problem}`)
    : pass("audio", "test tone", `played the 0.2 s listening tone on ${device}: you should have heard two rising notes`);
}

export const audioCheck: Check = {
  name: "audio",
  timeoutMs: 15_000,
  run: async (ctx) => [await micLine(ctx), await speakerLine(ctx), await toneLine(ctx)],
};

// ---- voice ----

/** Placeholder: Piper took 3.3 to 3.8 s per line on the Pi 5 (it loads the voice each time). */
export const PIPER_TIMEOUT_MS = 15_000;
const TEST_LINE = "Sophi check.";

export async function voiceLines(ctx: CheckContext): Promise<CheckLine[]> {
  if (!isLinux(ctx)) return [skip("voice", "voice", NOT_A_PI(ctx))];
  const espeak = await ctx.run("espeak-ng", ["--version"]);
  const espeakVersion = espeak.code === 0 ? (/(\d+\.\d+[\w.-]*)/.exec(text(espeak))?.[1] ?? "present") : null;
  const fallback = espeakVersion ? `espeak-ng ${espeakVersion} is the fallback` : "espeak-ng is missing too";
  const model = ctx.env.WALKER_PIPER_MODEL;
  if (!model) {
    return [
      espeakVersion
        ? pass("voice", "espeak-ng", `${espeakVersion}; no WALKER_PIPER_MODEL, so the walker speaks with espeak-ng`)
        : fail("voice", "espeak-ng", "no WALKER_PIPER_MODEL and espeak-ng is not installed: the walker can't speak"),
    ];
  }
  const missing = [model, `${model}.json`].filter((path) => ctx.files.size(path) === null);
  const degrade = (detail: string) => [espeakVersion ? warn("voice", "piper", `${detail}; ${fallback}`) : fail("voice", "piper", `${detail}; ${fallback}`)];
  if (missing.length) return degrade(`missing ${missing.join(" and ")}`);
  // A private folder for the one WAV, removed whatever happens.
  const dir = mkdtempSync(join(tmpdir(), "walker-check-"));
  try {
    const out = join(dir, "check.wav");
    const result = await ctx.run("piper", ["--model", model, "--output_file", out], { input: TEST_LINE, timeoutMs: PIPER_TIMEOUT_MS });
    const problem = commandProblem("piper", result);
    if (problem) return degrade(problem);
    const bytes = ctx.files.size(out) ?? 0;
    if (bytes <= 44) return degrade("piper exited 0 but wrote no audio");
    return [pass("voice", "piper", `"${TEST_LINE}" synthesized in ${(result.ms / 1000).toFixed(1)} s with ${model.split("/").at(-1)}; ${fallback}`)];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const voiceCheck: Check = { name: "voice", timeoutMs: PIPER_TIMEOUT_MS + 5000, run: voiceLines };

// ---- screen ----

const DRM_DIR = "/sys/class/drm";

export function hdmiLine(ctx: CheckContext): CheckLine {
  if (!isLinux(ctx)) return skip("screen", "hdmi", NOT_A_PI(ctx));
  const connectors = (ctx.files.list(DRM_DIR) ?? []).filter((name) => /-HDMI-/.test(name));
  if (connectors.length === 0) return fail("screen", "hdmi", `no HDMI connectors under ${DRM_DIR}`);
  const states = connectors.map((name) => {
    const status = ctx.files.read(join(DRM_DIR, name, "status"));
    const modes = ctx.files.read(join(DRM_DIR, name, "modes"));
    return {
      name: name.replace(/^card\d+-/, ""),
      connected: typeof status === "string" && status.trim() === "connected",
      modes: typeof modes === "string" ? [...new Set(modes.split("\n").map((m) => m.trim()).filter(Boolean))] : [],
    };
  });
  const connected = states.filter((s) => s.connected);
  if (connected.length === 0) return fail("screen", "hdmi", `nothing connected (${states.map((s) => `${s.name} disconnected`).join(", ")}). Check the HDMI cable and the screen's power`);
  const good = connected.find((s) => s.modes.includes("800x480"));
  const describe = (s: (typeof states)[number]) => `${s.name} connected, modes ${s.modes.slice(0, 4).join(", ") || "none reported"}${s.modes.length > 4 ? ", …" : ""}`;
  if (good) return pass("screen", "hdmi", describe(good));
  return warn("screen", "hdmi", `${connected.map(describe).join("; ")} (expected 800x480 for the 5-inch screen)`);
}

interface InputDevice {
  name: string;
  handlers: string[];
  phys: string;
  /** Reports an absolute position: ABS_X and ABS_Y, or the multitouch ABS_MT_POSITION_X and _Y. */
  pointer: boolean;
}

/** Bits 0, 1 (ABS_X, ABS_Y) and 53, 54 (ABS_MT_POSITION_X, _Y) of the kernel's ABS bitmap (low word last). */
function absPointer(bitmap: string): boolean {
  const low = bitmap.trim().split(/\s+/).at(-1);
  if (!low || !/^[0-9a-f]+$/i.test(low)) return false;
  const bits = BigInt(`0x${low}`);
  const has = (bit: number) => (bits & (1n << BigInt(bit))) !== 0n;
  return (has(0) && has(1)) || (has(53) && has(54));
}

export function parseInputDevices(contents: string): InputDevice[] {
  return contents
    .split(/\n\s*\n/)
    .map((block) => {
      const field = (re: RegExp) => re.exec(block)?.[1] ?? "";
      return {
        name: field(/^N: Name="(.*)"$/m),
        handlers: field(/^H: Handlers=(.*)$/m).trim().split(/\s+/).filter(Boolean),
        phys: field(/^P: Phys=(.*)$/m),
        // A volume knob can report an absolute axis too (ABS_VOLUME), so only X and Y count.
        pointer: absPointer(field(/^B: ABS=([0-9a-fA-F ]+)$/m)),
      };
    })
    .filter((device) => device.name !== "");
}

export function touchLine(ctx: CheckContext): CheckLine {
  if (!isLinux(ctx)) return skip("screen", "touch", NOT_A_PI(ctx));
  const contents = ctx.files.read("/proc/bus/input/devices");
  if (typeof contents !== "string") return fail("screen", "touch", "couldn't read /proc/bus/input/devices");
  // A touch screen reports an absolute X and Y; keyboards, mice and the soundbar's volume keys don't.
  const touch = parseInputDevices(contents).filter((device) => device.pointer);
  if (touch.length === 0) return fail("screen", "touch", "no input device reports an absolute X and Y: is the screen's touch USB cable plugged into the Pi?");
  const describe = (d: InputDevice) => `"${d.name}" (${d.handlers.find((h) => h.startsWith("event")) ?? "no event handler"}${d.phys.startsWith("usb") ? ", USB" : ""})`;
  return pass("screen", "touch", touch.map(describe).join(", "));
}

export const screenCheck: Check = { name: "screen", timeoutMs: 5000, run: async (ctx) => [hdmiLine(ctx), touchLine(ctx)] };

// ---- GPIO buttons ----

export async function gpioLine(ctx: CheckContext): Promise<CheckLine> {
  if (ctx.env.WALKER_GPIO_BUTTONS !== "wired") return skip("gpio", "buttons", "WALKER_GPIO_BUTTONS isn't wired, so the walker doesn't use the Pi's GPIO buttons");
  if (!isLinux(ctx)) return skip("gpio", "buttons", NOT_A_PI(ctx));
  const chip = ctx.env.WALKER_GPIO_CHIP || "gpiochip0";
  const lines = { Talk: Number(ctx.env.WALKER_GPIO_TALK || 17), Confirm: Number(ctx.env.WALKER_GPIO_CONFIRM || 27) };
  const args = ctx.env.WALKER_GPIOMON === "v2" ? ["--chip", chip] : [chip];
  const result = await ctx.run("gpioinfo", args);
  const problem = commandProblem("gpioinfo", result);
  if (problem) return fail("gpio", "buttons", `${chip}: ${problem}`);
  const found = new Map<number, string>();
  for (const line of text(result).split("\n")) {
    const match = /line\s+(\d+):\s+"([^"]*)"\s*(.*)$/.exec(line);
    if (!match) continue;
    // v2 prints `consumer="gpiomon"`; v1 prints the consumer as a second quoted name (or `unused`).
    const rest = match[3]!.trim();
    const consumer = /consumer="([^"]+)"/.exec(rest)?.[1] ?? /^"([^"]+)"/.exec(rest)?.[1];
    found.set(Number(match[1]), `${match[2]}${consumer ? ` (in use by ${consumer})` : ""}`);
  }
  const parts = Object.entries(lines).map(([role, offset]) => ({ role, offset, info: found.get(offset) }));
  const missing = parts.filter((p) => p.info === undefined);
  if (missing.length) return fail("gpio", "buttons", `${chip} has no line ${missing.map((p) => `${p.offset} (${p.role})`).join(", ")}: check WALKER_GPIO_CHIP with gpioinfo`);
  return pass("gpio", "buttons", `${chip}: ${parts.map((p) => `${p.role} line ${p.offset} ${p.info}`).join(", ")}. Press test: README step 3`);
}

export const gpioCheck: Check = { name: "gpio", timeoutMs: 8000, run: async (ctx) => [await gpioLine(ctx)] };

// ---- the hardware stop's stop-sense input ----

/**
 * WALKER_STOP_SENSE, with the motion coordinator's rules (claude/motion-arms, not merged yet): `gpio:<BCM line>`
 * when the stop's normally closed stop-sense contact is wired to that Pi line, or `not_wired` (the default).
 * null when it is neither.
 */
export function readStopSense(value: string | undefined): { kind: "not_wired" } | { kind: "gpio"; line: number } | null {
  if (value === undefined || value === "" || value === "not_wired") return { kind: "not_wired" };
  const match = /^gpio:(\d{1,2})$/.exec(value);
  if (!match) return null;
  const line = Number(match[1]);
  return line <= 63 ? { kind: "gpio", line } : null;
}

/** One read of the line as an input with the pull-up on (as the coordinator reads it). Never drives the line. */
export function gpiogetArgs(flavor: string | undefined, chip: string, line: number): string[] {
  return flavor === "v2" ? ["--chip", chip, "--bias=pull-up", "--numeric", String(line)] : ["--bias=pull-up", chip, String(line)];
}

export async function stopLine(ctx: CheckContext): Promise<CheckLine> {
  if (!isLinux(ctx)) return skip("stop", "stop switch", NOT_A_PI(ctx));
  const value = ctx.env.WALKER_STOP_SENSE;
  const setting = readStopSense(value);
  if (!setting) return fail("stop", "stop switch", `WALKER_STOP_SENSE=${value}: must be gpio:<BCM line> or not_wired (with anything else the motion coordinator turns motion off)`);
  if (setting.kind === "not_wired") {
    const bench = ctx.env[MOTION_BENCH_ENV] === MOTION_BENCH_ENV_VALUE;
    return warn(
      "stop",
      "stop switch",
      `not_wired (WALKER_STOP_SENSE ${value ? "is not_wired" : "unset"}): with no stop-sense input, the lift never moves, and arm motion is refused` +
        (bench ? `; ${MOTION_BENCH_ENV} is on, so the arms move under the bench limits with no hardware stop` : ` unless ${MOTION_BENCH_ENV}=${MOTION_BENCH_ENV_VALUE} (bench mode)`),
    );
  }
  const chip = ctx.env.WALKER_GPIO_CHIP || "gpiochip0";
  const result = await ctx.run("gpioget", gpiogetArgs(ctx.env.WALKER_GPIOMON, chip, setting.line));
  const problem = commandProblem("gpioget", result);
  const output = text(result).trim();
  const level = output === "0" || /=inactive$/.test(output) ? "low" : output === "1" || /=active$/.test(output) ? "high" : null;
  if (problem || level === null) {
    const held = ctx.facts.serviceActive ? ` (${SERVICE_UNIT} may be watching it)` : "";
    return fail("stop", "stop switch", `couldn't read ${chip} line ${setting.line}: ${problem ?? `unexpected output "${output.slice(0, 40)}"`}${held}; the coordinator counts an unreadable stop as pressed`);
  }
  // Normally closed to ground: released holds the line low; pressed opens it and the pull-up reads high.
  return level === "low"
    ? pass("stop", "stop switch", `released: ${chip} line ${setting.line} reads low (the normally closed contact is closed)`)
    : warn("stop", "stop switch", `PRESSED, or its wire is cut: ${chip} line ${setting.line} reads high through the pull-up. Motion is refused until it is released`);
}

export const stopCheck: Check = { name: "stop", timeoutMs: 8000, run: async (ctx) => [await stopLine(ctx)] };
