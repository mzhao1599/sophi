import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WALKER_SETUP } from "@walker/contracts";
import { describe, expect, it } from "vitest";
import { HttpCloudClient } from "../src/cloud/client";
import { CloudError } from "../src/cloud/client";
import { realFiles, runChecks, summarize, formatLine, type CheckContext, type CheckLine, type FileAccess, type RunResult, type Runner } from "../src/check/core";
import { audioCheck, gpioLine, hdmiLine, micLine, speakerLine, toneLine, touchLine, voiceLines } from "../src/check/devices";
import { walkerCheck, type CheckDeps } from "../src/check";
import type { SerialSource } from "../src/check/modules";
import {
  clockLine,
  diskLine,
  dnsLine,
  healthLine,
  memoryLine,
  osLine,
  pairingLines,
  routeLine,
  serviceLine,
  throttleLine,
  wifiLine,
  type NetworkDeps,
} from "../src/check/system";
import { FakeCloud, startFakeCloudServer } from "../src/sim/fakeCloud";
import { silentLogger } from "../src/log";
import { FakeClock } from "./support/fakes";

/**
 * Rows K1–K14 and K20–K21 (test/EXPECTED.md): each check against a fake command runner and fake files.
 * The command outputs below are written from each tool's documented format, not captured on the Pi.
 */

type Reply = { out?: string | Buffer; code?: number | null; stderr?: string; timedOut?: boolean; ms?: number };

function fakeRunner(replies: Record<string, Reply | ((args: readonly string[], input?: string | Buffer) => Reply)>) {
  const calls: Array<{ argv: string[]; input?: string | Buffer }> = [];
  const run: Runner = async (command, args, options = {}) => {
    calls.push({ argv: [command, ...args], ...(options.input !== undefined ? { input: options.input } : {}) });
    const reply = replies[[command, ...args].join(" ")] ?? replies[command];
    if (!reply) return { code: null, stdout: Buffer.alloc(0), stderr: "", missing: true, timedOut: false, ms: 0 };
    const r = typeof reply === "function" ? reply(args, options.input) : reply;
    const stdout = Buffer.isBuffer(r.out) ? r.out : Buffer.from(r.out ?? "");
    return { code: r.timedOut ? null : (r.code ?? 0), stdout, stderr: r.stderr ?? "", missing: false, timedOut: r.timedOut ?? false, ms: r.ms ?? 5 };
  };
  return { run, calls };
}

function fakeFiles(map: Record<string, string | { error: string }>, modes: Record<string, number> = {}): FileAccess {
  return {
    read: (path) => map[path] ?? null,
    list: (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const names = new Set(Object.keys(map).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split("/")[0]!));
      return names.size ? [...names].sort() : null;
    },
    mode: (path) => (path in map ? (modes[path] ?? 0o600) : null),
    size: (path) => {
      const value = map[path];
      return typeof value === "string" ? value.length : null;
    },
  };
}

function makeCtx(over: Partial<Omit<CheckContext, "options">> & { options?: Partial<CheckContext["options"]> } = {}): CheckContext {
  return {
    run: fakeRunner({}).run,
    files: fakeFiles({}),
    clock: new FakeClock(),
    platform: "linux",
    arch: "arm64",
    env: {},
    say: () => {},
    facts: { serviceActive: null },
    ...over,
    options: {
      server: undefined,
      stateDir: "/var/lib/steady-walker",
      stateDirGiven: false,
      sound: false,
      buzz: false,
      press: false,
      sim: false,
      ports: null,
      expect: [],
      ...over.options,
    },
  };
}

// ---- Realistic outputs, written from the tools' documented formats ----

const OS_RELEASE = `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\nVERSION="13 (trixie)"\nVERSION_CODENAME=trixie\nID=debian\n`;
const MEMINFO = "MemTotal:        4146448 kB\nMemFree:         2716000 kB\nMemAvailable:    3512000 kB\n";
const DF = "Filesystem     1024-blocks    Used Available Capacity Mounted on\n/dev/mmcblk0p2    59610000 5100000  51900000       9% /\n";
const ROUTES = "default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.50 metric 100\ndefault via 172.20.10.1 dev wlan0 proto dhcp src 172.20.10.3 metric 600\n";
const NMCLI = "Wired connection 1:802-3-ethernet:yes\nlo:loopback:no\n";
const APLAY_L = [
  "null",
  "    Discard all samples (playback) or generate zero samples (capture)",
  "default:CARD=Speaker",
  "    USB Composite Device, USB Audio",
  "    Default Audio Device",
  "plughw:CARD=Speaker,DEV=0",
  "    USB Composite Device, USB Audio",
  "hdmi:CARD=vc4hdmi0,DEV=0",
  "    vc4-hdmi-0, MAI PCM i2s-hifi-0",
  "",
].join("\n");
const INPUT_DEVICES = [
  'I: Bus=0003 Vendor=5a47 Product=5858 Version=0111\nN: Name="USB Composite Device Consumer Control"\nP: Phys=usb-xhci-hcd.0-2/input3\nH: Handlers=kbd event3 \nB: PROP=0\nB: EV=1f\nB: ABS=10000000000\n',
  'I: Bus=0003 Vendor=0eef Product=0005 Version=0111\nN: Name="ELECROW Touch"\nP: Phys=usb-xhci-hcd.1-1/input0\nH: Handlers=mouse0 event4 \nB: PROP=2\nB: EV=b\nB: KEY=400 0 0 0 0 0\nB: ABS=260800000003\n',
].join("\n");
const PI_ENV = "WALKER_ALSA_CAPTURE=plughw:CARD=SF558,DEV=0\nWALKER_ALSA_PLAYBACK=default:CARD=Speaker\nWALKER_GPIOMON=v2\n";

function pcm(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => buffer.writeInt16LE(value, i * 2));
  return buffer;
}

const statusOf = (line: CheckLine) => line.status;

describe("walker check: output and exit code", () => {
  it("K1: one plain line per item, a summary, exit 1 only on a FAIL", () => {
    const lines: CheckLine[] = [
      { status: "PASS", group: "system", item: "OS", detail: "trixie" },
      { status: "WARN", group: "network", item: "default route", detail: "wlan0" },
      { status: "SKIP", group: "gpio", item: "buttons", detail: "not wired" },
    ];
    expect(formatLine(lines[0]!)).toBe(`PASS  system   ${"OS".padEnd(20)} trixie`);
    expect(summarize(lines, 1.25)).toEqual({ text: "Summary: 1 pass, 1 warn, 0 fail, 1 skip, in 1.3 s.\nNothing failed.\nWarnings: network default route.", exitCode: 0 });
    const failed = summarize([...lines, { status: "FAIL", group: "audio", item: "microphone", detail: "busy" }], 2);
    expect(failed.exitCode).toBe(1);
    expect(failed.text).toContain("Failed: audio microphone.");
    for (const line of lines) expect(formatLine(line)).toMatch(/^[A-Z]{4}  [ -~]+$/);
  });

  it("K4: a check that never answers is one FAIL line, and the run carries on", async () => {
    const clock = new FakeClock();
    const ctx = makeCtx({ clock });
    const printed: string[] = [];
    const done = runChecks(ctx, [
      { name: "stuck", timeoutMs: 2000, run: () => new Promise<CheckLine[]>(() => {}) },
      { name: "next", timeoutMs: 2000, run: async () => [{ status: "PASS", group: "next", item: "x", detail: "ran" }] },
    ], (line) => printed.push(formatLine(line)));
    await clock.advance(2500);
    const lines = await done;
    expect(lines.map((l) => [l.status, l.group, l.detail])).toEqual([["FAIL", "stuck", "no answer within 2 s"], ["PASS", "next", "ran"]]);
    expect(printed).toHaveLength(2);
  });
});

describe("walker check: system", () => {
  it("K6: OS, clock, power, memory and disk on a healthy Pi", async () => {
    const { run } = fakeRunner({
      "timedatectl show -p NTPSynchronized --value": { out: "yes\n" },
      "vcgencmd get_throttled": { out: "throttled=0x0\n" },
      "vcgencmd measure_temp": { out: "temp=47.2'C\n" },
      df: { out: DF },
    });
    const ctx = makeCtx({ run, files: fakeFiles({ "/etc/os-release": OS_RELEASE, "/proc/meminfo": MEMINFO }) });
    expect(osLine(ctx)).toMatchObject({ status: "PASS", detail: expect.stringContaining("Debian GNU/Linux 13 (trixie), aarch64") });
    expect(await clockLine(ctx)).toMatchObject({ status: "PASS", detail: expect.stringMatching(/^synchronized, 2026-/) });
    expect(await throttleLine(ctx)).toMatchObject({ status: "PASS", detail: expect.stringContaining("0x0 (no under-voltage or throttling since boot), 47.2 °C") });
    expect(memoryLine(ctx)).toMatchObject({ status: "PASS", detail: "3430 MB available of 4049 MB" });
    expect(await diskLine(ctx)).toMatchObject({ status: "PASS", detail: "49.5 GB free of 56.8 GB on /" });
  });

  it("K6: bookworm warns, an unsynced clock fails, throttle bits are named", async () => {
    const files = fakeFiles({ "/etc/os-release": OS_RELEASE.replace(/trixie/g, "bookworm"), "/proc/meminfo": "MemTotal: 4146448 kB\nMemAvailable: 150000 kB\n" });
    const now = fakeRunner({ "timedatectl show -p NTPSynchronized --value": { out: "no\n" }, "vcgencmd get_throttled": { out: "throttled=0x50005\n" } });
    const ctx = makeCtx({ run: now.run, files });
    expect(osLine(ctx).status).toBe("WARN");
    expect((await clockLine(ctx)).status).toBe("FAIL");
    const power = await throttleLine(ctx);
    expect(power.status).toBe("FAIL");
    expect(power.detail).toContain("under-voltage now, throttled now, under-voltage since boot, throttled since boot");
    expect(memoryLine(ctx).status).toBe("FAIL");
    const past = fakeRunner({ "vcgencmd get_throttled": { out: "throttled=0x10000\n" } });
    expect(await throttleLine(makeCtx({ run: past.run }))).toMatchObject({ status: "WARN", detail: expect.stringContaining("under-voltage since boot") });
    expect((await diskLine(makeCtx({ run: fakeRunner({ df: { out: DF.replace("51900000", "1500000") } }).run }))).status).toBe("WARN");
  });

  it("K7: the walker service's state", async () => {
    const service = async (active: string, enabled: string, code = 0) => {
      const { run } = fakeRunner({ "systemctl is-active steady-walker": { out: `${active}\n`, code }, "systemctl is-enabled steady-walker": { out: `${enabled}\n` } });
      const ctx = makeCtx({ run });
      return { line: await serviceLine(ctx), active: ctx.facts.serviceActive };
    };
    expect(await service("active", "enabled")).toEqual({ line: expect.objectContaining({ status: "PASS", detail: "steady-walker is active, starts at boot" }), active: true });
    expect(await service("inactive", "enabled", 3)).toMatchObject({ line: { status: "WARN" }, active: false });
    expect((await service("failed", "enabled", 3)).line.status).toBe("FAIL");
    expect((await service("active", "disabled")).line.status).toBe("FAIL");
    expect((await service("inactive", "", 4)).line.detail).toContain("boot: not installed");
  });

  it("K5: on a Mac every Pi-only line skips", async () => {
    const ctx = makeCtx({ platform: "darwin" });
    const lines = [osLine(ctx), await clockLine(ctx), await serviceLine(ctx), await routeLine(ctx), await wifiLine(ctx), await micLine(ctx), hdmiLine(ctx), touchLine(ctx), ...(await voiceLines(ctx))];
    expect(lines.map(statusOf)).toEqual(Array(lines.length).fill("SKIP"));
    expect(lines[0]!.detail).toContain("not a Pi (darwin)");
  });
});

describe("walker check: network and pairing", () => {
  it("K8: the lowest-metric default route, Ethernet passes and Wi-Fi warns", async () => {
    const eth = await routeLine(makeCtx({ run: fakeRunner({ "ip route show default": { out: ROUTES } }).run }));
    expect(eth).toMatchObject({ status: "PASS", detail: "eth0 192.168.1.50 via 192.168.1.1, metric 100; also wlan0 (metric 600)" });
    const wifi = await routeLine(makeCtx({ run: fakeRunner({ "ip route show default": { out: ROUTES.split("\n")[1]! } }).run }));
    expect(wifi.status).toBe("WARN");
    expect(wifi.detail).toContain("venue plan is the Ethernet hardline");
    expect((await routeLine(makeCtx({ run: fakeRunner({ "ip route show default": { out: "" } }).run }))).status).toBe("FAIL");
  });

  it("K9: Wi-Fi connections that autoconnect warn, named whole even with a colon", async () => {
    const out = `${NMCLI}preconfigured:802-11-wireless:yes\nwalker\\: Home\\:5G:802-11-wireless:yes\nwalker\\: Venue:802-11-wireless:no\n`;
    const { run, calls } = fakeRunner({ nmcli: { out } });
    const line = await wifiLine(makeCtx({ run }));
    expect(line.status).toBe("WARN");
    expect(line.detail).toContain('"preconfigured", "walker: Home:5G"');
    expect(line.detail).not.toContain("Venue");
    expect(calls.map((c) => c.argv)).toEqual([["nmcli", "-t", "-f", "NAME,TYPE,AUTOCONNECT", "connection", "show"]]);
    expect(await wifiLine(makeCtx({ run: fakeRunner({ nmcli: { out: `${NMCLI}walker\\: Venue:802-11-wireless:no\n` } }).run }))).toMatchObject({ status: "PASS", detail: "1 Wi-Fi connection saved, none autoconnects" });
    expect((await wifiLine(makeCtx())).status).toBe("SKIP");
  });

  const net = (over: Partial<NetworkDeps> = {}): NetworkDeps => ({
    lookup: async () => ["216.24.57.4", "216.24.57.252"],
    health: async () => "ok",
    configuration: async () => ({ version: 3, cues: ["vibration", "sound"] }),
    ...over,
  });

  it("K10: DNS and health for --server, else the credential's server", async () => {
    const ctx = makeCtx({ options: { server: "https://steady-walker.onrender.com" } });
    expect(await dnsLine(ctx, net())).toMatchObject({ status: "PASS", detail: "steady-walker.onrender.com → 216.24.57.4, 216.24.57.252" });
    expect(await healthLine(ctx, net())).toMatchObject({ status: "PASS", detail: expect.stringMatching(/^https:\/\/steady-walker.onrender.com\/api\/v1\/health ok in \d+ ms$/) });
    expect((await healthLine(ctx, net({ health: async () => "off" }))).detail).toContain("walkers turned off");
    expect((await healthLine(ctx, net({ health: async () => "not_ready" }))).status).toBe("FAIL");
    expect((await healthLine(ctx, net({ health: async () => { throw new CloudError("unreachable", "x"); } }))).detail).toContain("unreachable");
    const dnsFail = await dnsLine(ctx, net({ lookup: async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); } }));
    expect(dnsFail).toMatchObject({ status: "FAIL", detail: "steady-walker.onrender.com: ENOTFOUND" });
    expect((await dnsLine(makeCtx(), net())).status).toBe("SKIP");
  });

  it("K10: a health call that hangs fails at 20 s", async () => {
    const clock = new FakeClock();
    const ctx = makeCtx({ clock, options: { server: "https://steady-walker.onrender.com" } });
    const line = healthLine(ctx, net({ health: () => new Promise(() => {}) }));
    await clock.advance(20_001);
    expect(await line).toMatchObject({ status: "FAIL", detail: expect.stringContaining("no answer within 20 s") });
  });

  it("K11, K3: pairing against the fake cloud over HTTP: accepted, then refused after Forget; the credential is never shown", async () => {
    const cloud = new FakeCloud(new FakeClock());
    const server = await startFakeCloudServer(cloud, silentLogger);
    try {
      const paired = cloud.pair({ code: cloud.issueCode(), service_version: "test" });
      const dir = mkdtempSync(join(tmpdir(), "walker-check-state-"));
      const file = join(dir, "credential.json");
      writeFileSync(file, JSON.stringify({ server_url: server.url, device_id: paired.device_id, credential: paired.credential }), { mode: 0o600 });
      const http: NetworkDeps = {
        ...net(),
        configuration: (credential, signal) => new HttpCloudClient(credential.server_url, credential.device_id, credential.credential).configuration(signal),
      };
      const ctx = makeCtx({ files: realFiles, options: { stateDir: dir, stateDirGiven: true } });
      const ok = await pairingLines(ctx, http);
      expect(ok.map(statusOf)).toEqual(["PASS", "PASS"]);
      expect(ok[0]!.detail).toBe(`device ${paired.device_id} on ${server.url}, mode 600`);
      expect(ok[1]!.detail).toBe(`configuration version 1, cues: ${WALKER_SETUP.cues.join(", ")}`);
      cloud.forget(paired.device_id);
      const refused = await pairingLines(ctx, http);
      expect(refused[1]).toMatchObject({ status: "FAIL", detail: expect.stringContaining("pair again") });
      chmodSync(file, 0o644);
      expect((await pairingLines(ctx, http))[0]!.status).toBe("WARN");
      for (const line of [...ok, ...refused]) expect(JSON.stringify(line)).not.toContain(paired.credential);
    } finally {
      await server.close();
    }
  });

  it("K11: missing, unreadable and malformed credential files fail", async () => {
    const at = "/var/lib/steady-walker/credential.json";
    const missing = await pairingLines(makeCtx(), net());
    expect(missing).toEqual([expect.objectContaining({ status: "FAIL", detail: expect.stringContaining("not paired") })]);
    const denied = await pairingLines(makeCtx({ files: fakeFiles({ [at]: { error: "EACCES" } }) }), net());
    expect(denied[0]!.detail).toContain("run the check with sudo");
    const junk = await pairingLines(makeCtx({ files: fakeFiles({ [at]: "{" }) }), net());
    expect(junk[0]).toMatchObject({ status: "FAIL", detail: expect.stringContaining("pair again") });
    expect((await pairingLines(makeCtx({ platform: "darwin" }), net()))[0]!.status).toBe("SKIP");
  });
});

describe("walker check: audio, voice, screen, GPIO", () => {
  const env = { WALKER_ALSA_CAPTURE: "plughw:CARD=SF558,DEV=0", WALKER_ALSA_PLAYBACK: "default:CARD=Speaker" };

  it("K12: 1 s from the mic in the service's format, level shown, then zeroed", async () => {
    const audio = pcm(Array.from({ length: 16000 }, (_, i) => (i % 2 ? 120 : -80)));
    const { run, calls } = fakeRunner({ arecord: { out: audio } });
    // The fake hands back the same buffer, so the test can see it zeroed.
    const ctx = makeCtx({ run: async (c, a, o) => ({ ...(await run(c, a, o)), stdout: audio }), env });
    expect(await micLine(ctx)).toMatchObject({ status: "PASS", detail: "plughw:CARD=SF558,DEV=0: 1.0 s recorded, peak 120 of 32767, RMS 102" });
    expect(calls[0]!.argv).toEqual(["arecord", "-q", "-D", "plughw:CARD=SF558,DEV=0", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw", "-d", "1"]);
    expect(audio.every((byte) => byte === 0)).toBe(true);
    expect((await micLine(makeCtx({ run: fakeRunner({ arecord: { out: pcm(Array(16000).fill(0)) } }).run, env }))).detail).toContain("every sample is 0");
    const busy = await micLine(makeCtx({ run: fakeRunner({ arecord: { code: 1, stderr: "arecord: main:850: audio open error: Device or resource busy\n" } }).run, env }));
    expect(busy).toMatchObject({ status: "FAIL", detail: expect.stringContaining("Device or resource busy") });
    expect((await micLine(makeCtx())).detail).toContain("WALKER_ALSA_CAPTURE is not set");
  });

  it("K13: the speaker is listed by aplay -L; --sound pipes one tone, never otherwise", async () => {
    const { run, calls } = fakeRunner({ "aplay -L": { out: APLAY_L }, aplay: {} });
    expect(await speakerLine(makeCtx({ run, env }))).toMatchObject({ status: "PASS" });
    const other = await speakerLine(makeCtx({ run, env: { ...env, WALKER_ALSA_PLAYBACK: "default:CARD=Soundbar" } }));
    expect(other).toMatchObject({ status: "FAIL", detail: expect.stringContaining("cards: Speaker, vc4hdmi0") });
    expect((await toneLine(makeCtx({ run, env }))).status).toBe("SKIP");
    expect(calls.some((c) => c.argv.includes("-q"))).toBe(false);
    expect(await toneLine(makeCtx({ run, env, options: { sound: true } }))).toMatchObject({ status: "PASS" });
    const tone = calls.at(-1)!;
    expect(tone.argv).toEqual(["aplay", "-q", "-D", "default:CARD=Speaker", "-"]);
    expect(Buffer.isBuffer(tone.input) && tone.input.subarray(0, 4).toString()).toBe("RIFF");
  });

  it("K14: Piper synthesizes into a private folder that is removed; failures fall back to espeak-ng", async () => {
    const model = "/opt/steady-walker/voices/en_US-lessac-medium.onnx";
    const files = fakeFiles({ [model]: "onnx", [`${model}.json`]: "{}" });
    let out = "";
    const piper = (args: readonly string[], input?: string | Buffer) => {
      out = args[3]!;
      expect(input).toBe("Sophi check.");
      writeFileSync(out, Buffer.alloc(20_000));
      return { ms: 3400 };
    };
    const { run } = fakeRunner({ "espeak-ng --version": { out: "eSpeak NG text-to-speech: 1.52.0  Data at: /usr/lib/aarch64-linux-gnu/espeak-ng-data\n" }, piper });
    const real = { ...files, size: (path: string) => (path === out ? realFiles.size(path) : files.size(path)) };
    const ok = await voiceLines(makeCtx({ run, files: real, env: { WALKER_PIPER_MODEL: model } }));
    expect(ok).toEqual([expect.objectContaining({ status: "PASS", detail: '"Sophi check." synthesized in 3.4 s with en_US-lessac-medium.onnx; espeak-ng 1.52.0 is the fallback' })]);
    expect(existsSync(out)).toBe(false);
    const slow = fakeRunner({ "espeak-ng --version": { out: "eSpeak NG 1.52.0" }, piper: { timedOut: true, ms: 15_000 } });
    expect((await voiceLines(makeCtx({ run: slow.run, files, env: { WALKER_PIPER_MODEL: model } })))[0]).toMatchObject({ status: "WARN", detail: expect.stringContaining("no answer within 15 s") });
    expect((await voiceLines(makeCtx({ files: fakeFiles({}), env: { WALKER_PIPER_MODEL: model } })))[0]).toMatchObject({ status: "FAIL", detail: expect.stringContaining("missing") });
    expect((await voiceLines(makeCtx({ run: slow.run })))[0]).toMatchObject({ status: "PASS", detail: expect.stringContaining("espeak-ng") });
    expect((await voiceLines(makeCtx()))[0]!.status).toBe("FAIL");
  });

  it("K20: HDMI connected at 800x480 and a touch device with absolute X and Y", () => {
    const drm = (status: string, modes: string) => ({
      "/sys/class/drm/card1-HDMI-A-1/status": `${status}\n`,
      "/sys/class/drm/card1-HDMI-A-1/modes": modes,
      "/sys/class/drm/card1-HDMI-A-2/status": "disconnected\n",
      "/sys/class/drm/card1-HDMI-A-2/modes": "",
      "/sys/class/drm/version": "drm 1.1.0 20060810\n",
      "/proc/bus/input/devices": INPUT_DEVICES,
    });
    const good = makeCtx({ files: fakeFiles(drm("connected", "800x480\n800x480\n640x480\n")) });
    expect(hdmiLine(good)).toMatchObject({ status: "PASS", detail: "HDMI-A-1 connected, modes 800x480, 640x480" });
    expect(touchLine(good)).toMatchObject({ status: "PASS", detail: '"ELECROW Touch" (event4, USB)' });
    expect(hdmiLine(makeCtx({ files: fakeFiles(drm("connected", "1024x600\n")) })).status).toBe("WARN");
    expect(hdmiLine(makeCtx({ files: fakeFiles(drm("disconnected", "")) })).detail).toContain("HDMI-A-1 disconnected, HDMI-A-2 disconnected");
    // The soundbar's volume control reports an absolute axis (ABS_VOLUME), but no X and Y: not a touch screen.
    const noTouch = makeCtx({ files: fakeFiles({ "/proc/bus/input/devices": INPUT_DEVICES.split("\n\n")[0]! }) });
    expect(touchLine(noTouch).status).toBe("FAIL");
  });

  it("K21: GPIO lines from gpioinfo, v2 and v1 formats, only when declared wired", async () => {
    expect((await gpioLine(makeCtx())).status).toBe("SKIP");
    const v2 = '\tline  17:\t"GPIO17"        \tinput\n\tline  27:\t"GPIO27"        \tinput consumer="gpiomon"\n';
    const wired = { WALKER_GPIO_BUTTONS: "wired", WALKER_GPIOMON: "v2" };
    const { run, calls } = fakeRunner({ gpioinfo: { out: `gpiochip0 - 54 lines:\n${v2}` } });
    expect(await gpioLine(makeCtx({ run, env: wired }))).toMatchObject({ status: "PASS", detail: expect.stringContaining("Talk line 17 GPIO17, Confirm line 27 GPIO27 (in use by gpiomon)") });
    expect(calls[0]!.argv).toEqual(["gpioinfo", "--chip", "gpiochip0"]);
    const v1 = '\tline  17:     "GPIO17"       unused   input  active-high \n\tline  27:     "GPIO27"    "gpiomon"   input  active-high [used]\n';
    const old = fakeRunner({ gpioinfo: { out: `gpiochip0 - 54 lines:\n${v1}` } });
    expect((await gpioLine(makeCtx({ run: old.run, env: { WALKER_GPIO_BUTTONS: "wired", WALKER_GPIOMON: "v1" } }))).detail).toContain("Talk line 17 GPIO17, Confirm line 27 GPIO27 (in use by gpiomon)");
    expect(old.calls[0]!.argv).toEqual(["gpioinfo", "gpiochip0"]);
    expect((await gpioLine(makeCtx({ run: fakeRunner({ gpioinfo: { out: "gpiochip0 - 54 lines:\n" } }).run, env: wired }))).status).toBe("FAIL");
  });
});

describe("walker check: the whole run", () => {
  const PI_COMMANDS: Record<string, Reply> = {
    "timedatectl show -p NTPSynchronized --value": { out: "yes\n" },
    "vcgencmd get_throttled": { out: "throttled=0x0\n" },
    "vcgencmd measure_temp": { out: "temp=47.2'C\n" },
    df: { out: DF },
    "systemctl is-active steady-walker": { out: "active\n" },
    "systemctl is-enabled steady-walker": { out: "enabled\n" },
    "ip route show default": { out: ROUTES.split("\n")[0]! },
    nmcli: { out: NMCLI },
    arecord: { out: pcm(Array.from({ length: 16000 }, (_, i) => (i % 3) * 40)) },
    "aplay -L": { out: APLAY_L },
    "espeak-ng --version": { out: "eSpeak NG text-to-speech: 1.52.0" },
    journalctl: { out: 'starting mic="plughw:CARD=SF558,DEV=0"\nmodule said hello module="hand-left-01" type="hand" firmware="0.1.0" simulated=false\n' },
  };
  const CREDENTIAL = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
  const PI_FILES = {
    "/etc/steady-walker.env": PI_ENV,
    "/etc/os-release": OS_RELEASE,
    "/proc/meminfo": MEMINFO,
    "/var/lib/steady-walker/credential.json": JSON.stringify({ server_url: "https://steady-walker.onrender.com", device_id: "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f", credential: CREDENTIAL }),
    "/sys/class/drm/card1-HDMI-A-1/status": "connected\n",
    "/sys/class/drm/card1-HDMI-A-1/modes": "800x480\n",
    "/proc/bus/input/devices": INPUT_DEVICES,
  };
  const noSerial: SerialSource = { simulated: false, ports: () => [], open: () => { throw new Error("no"); } };

  function deps(over: Partial<CheckDeps> = {}) {
    const runner = fakeRunner(PI_COMMANDS);
    const out: string[] = [];
    const d: CheckDeps = {
      run: runner.run,
      files: fakeFiles(PI_FILES),
      clock: new FakeClock(),
      platform: "linux",
      arch: "arm64",
      env: {},
      net: { lookup: async () => ["216.24.57.4"], health: async () => "ok", configuration: async () => ({ version: 2, cues: ["sound"] }) },
      serial: noSerial,
      write: (line) => out.push(line),
      ...over,
    };
    return { d, out, calls: runner.calls };
  }

  it("K2, K3, K15: a healthy Pi with the service running: exit 0, only read-only commands, no credential, modules from the log", async () => {
    const { d, out, calls } = deps();
    expect(await walkerCheck({ server: undefined, sound: false, buzz: false, press: false, sim: false, ports: null, expect: [] }, d)).toBe(0);
    const text = out.join("\n");
    expect(text).not.toContain(CREDENTIAL);
    expect(text).toContain("PASS  settings walker settings      from /etc/steady-walker.env: mic plughw:CARD=SF558,DEV=0, speaker default:CARD=Speaker, voice espeak-ng, GPIO buttons not declared");
    expect(text).toMatch(/SKIP  serial   modules +steady-walker is running and holds the serial ports.*hellos from hand-left-01 \(hand, firmware 0\.1\.0\)/);
    expect(text).toMatch(/Summary: \d+ pass, 0 warn, 0 fail, \d+ skip/);
    // Every command the check ran, by name and first argument: each only reads.
    const allowed = new Set(["timedatectl show", "vcgencmd get_throttled", "vcgencmd measure_temp", "df -Pk", "systemctl is-active", "systemctl is-enabled", "ip route", "nmcli -t", "arecord -q", "aplay -L", "espeak-ng --version", "journalctl -u"]);
    for (const call of calls) expect(allowed, call.argv.join(" ")).toContain(call.argv.slice(0, 2).join(" "));
  });

  it("K1: a missing setting and a refused credential fail the run with exit 1", async () => {
    const { d, out } = deps({
      files: fakeFiles({ ...PI_FILES, "/etc/steady-walker.env": "WALKER_ALSA_PLAYBACK=default:CARD=Speaker\n" }),
      net: { lookup: async () => ["216.24.57.4"], health: async () => "ok", configuration: async () => { throw new CloudError("unauthorized", "no", 401); } },
    });
    expect(await walkerCheck({ server: undefined, sound: false, buzz: false, press: false, sim: false, ports: null, expect: [] }, d)).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("FAIL  settings walker settings");
    expect(text).toContain("FAIL  audio    microphone           WALKER_ALSA_CAPTURE is not set");
    expect(text).toContain("FAIL  pairing  server accepts");
    expect(text).toMatch(/Failed: settings walker settings, pairing server accepts, audio microphone\./);
    expect(text).not.toContain(CREDENTIAL);
  });
});

// Keep the shared audio check list honest: it has exactly the three audio lines.
it("K13: the audio check is microphone, speaker, test tone", async () => {
  const lines = await audioCheck.run(makeCtx({ platform: "darwin" }));
  expect(lines.map((l) => l.item)).toEqual(["microphone", "speaker", "test tone"]);
});
