import { lookup } from "node:dns/promises";
import { join } from "node:path";
import { withDeadline } from "../clock";
import { CloudError, HttpCloudClient, checkHealth } from "../cloud/client";
import { CredentialFileSchema, type CredentialFile } from "../store";
import { NOT_A_PI, commandProblem, fail, isLinux, pass, skip, text, warn, type Check, type CheckContext, type CheckLine } from "./core";

/** The systemd unit's name (unchanged since the rename to Sophi). */
export const SERVICE_UNIT = "steady-walker";

// ---- system ----

/** Placeholders, not measured: below these the walker may stall (fail) or is getting tight (warn). */
export const MEMORY_FAIL_MB = 200;
export const MEMORY_WARN_MB = 500;
export const DISK_FAIL_MB = 500;
export const DISK_WARN_MB = 2000;

export function osLine(ctx: CheckContext): CheckLine {
  if (!isLinux(ctx)) return skip("system", "OS", NOT_A_PI(ctx));
  const release = ctx.files.read("/etc/os-release");
  const fields = typeof release === "string" ? Object.fromEntries(release.split("\n").map((l) => /^(\w+)=(.*)$/.exec(l)).filter((m) => m !== null).map((m) => [m[1]!, m[2]!.replace(/^"|"$/g, "")])) : {};
  const codename = fields.VERSION_CODENAME ?? "unknown";
  const arch = ctx.arch === "arm64" ? "aarch64" : ctx.arch;
  const detail = `${fields.PRETTY_NAME ?? "unknown OS"}, ${arch}, Node ${process.versions.node}`;
  return codename === "trixie" && ctx.arch === "arm64" ? pass("system", "OS", detail) : warn("system", "OS", `${detail} (the walker was set up on trixie, aarch64)`);
}

export async function clockLine(ctx: CheckContext): Promise<CheckLine> {
  if (!isLinux(ctx)) return skip("system", "clock", NOT_A_PI(ctx));
  const result = await ctx.run("timedatectl", ["show", "-p", "NTPSynchronized", "--value"]);
  const problem = commandProblem("timedatectl", result);
  if (problem) return fail("system", "clock", problem);
  const now = new Date(ctx.clock.now()).toISOString().replace(/\.\d+Z$/, "Z");
  return text(result).trim() === "yes"
    ? pass("system", "clock", `synchronized, ${now}`)
    : fail("system", "clock", `not synchronized yet (${now}); HTTPS fails with a wrong date. Wait a minute after the network is up, then see timedatectl timesync-status`);
}

const THROTTLE_BITS: Array<[number, string]> = [
  [0, "under-voltage now"],
  [1, "CPU frequency capped now"],
  [2, "throttled now"],
  [3, "soft temperature limit now"],
  [16, "under-voltage since boot"],
  [17, "frequency capped since boot"],
  [18, "throttled since boot"],
  [19, "soft temperature limit since boot"],
];

export async function throttleLine(ctx: CheckContext): Promise<CheckLine> {
  if (!isLinux(ctx)) return skip("system", "power", NOT_A_PI(ctx));
  const result = await ctx.run("vcgencmd", ["get_throttled"]);
  if (result.missing) return skip("system", "power", "vcgencmd is not installed (not Raspberry Pi OS?)");
  const problem = commandProblem("vcgencmd", result);
  if (problem) return fail("system", "power", problem);
  const match = /throttled=(0x[0-9a-fA-F]+)/.exec(text(result));
  if (!match) return fail("system", "power", `unexpected answer: ${text(result).trim().slice(0, 80)}`);
  const value = Number.parseInt(match[1]!, 16);
  const temp = await ctx.run("vcgencmd", ["measure_temp"]);
  const celsius = /temp=([\d.]+)/.exec(text(temp))?.[1];
  const heat = celsius ? `, ${celsius} °C` : "";
  const set = THROTTLE_BITS.filter(([bit]) => (value & (1 << bit)) !== 0);
  if (set.length === 0) return pass("system", "power", `get_throttled ${match[1]} (no under-voltage or throttling since boot)${heat}`);
  const words = set.map(([, name]) => name).join(", ");
  return set.some(([bit]) => bit < 4)
    ? fail("system", "power", `get_throttled ${match[1]}: ${words}${heat}. Check the supply and cable`)
    : warn("system", "power", `get_throttled ${match[1]}: ${words}${heat}`);
}

export function memoryLine(ctx: CheckContext): CheckLine {
  if (!isLinux(ctx)) return skip("system", "memory", NOT_A_PI(ctx));
  const info = ctx.files.read("/proc/meminfo");
  const kb = (name: string) => (typeof info === "string" ? Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(info)?.[1] ?? NaN) : NaN);
  const available = Math.round(kb("MemAvailable") / 1024);
  const total = Math.round(kb("MemTotal") / 1024);
  if (!Number.isFinite(available)) return fail("system", "memory", "couldn't read MemAvailable from /proc/meminfo");
  const detail = `${available} MB available of ${total} MB`;
  if (available < MEMORY_FAIL_MB) return fail("system", "memory", detail);
  return available < MEMORY_WARN_MB ? warn("system", "memory", detail) : pass("system", "memory", detail);
}

export async function diskLine(ctx: CheckContext): Promise<CheckLine> {
  if (!isLinux(ctx)) return skip("system", "disk", NOT_A_PI(ctx));
  const result = await ctx.run("df", ["-Pk", "/"]);
  const problem = commandProblem("df", result);
  if (problem) return fail("system", "disk", problem);
  // POSIX format: Filesystem 1024-blocks Used Available Capacity Mounted-on
  const row = text(result).trim().split("\n").at(-1)?.split(/\s+/) ?? [];
  const freeMb = Math.round(Number(row[3]) / 1024);
  const totalMb = Math.round(Number(row[1]) / 1024);
  if (!Number.isFinite(freeMb)) return fail("system", "disk", `unexpected df output: ${text(result).trim().slice(0, 80)}`);
  const detail = `${(freeMb / 1024).toFixed(1)} GB free of ${(totalMb / 1024).toFixed(1)} GB on /`;
  if (freeMb < DISK_FAIL_MB) return fail("system", "disk", detail);
  return freeMb < DISK_WARN_MB ? warn("system", "disk", detail) : pass("system", "disk", detail);
}

export async function serviceLine(ctx: CheckContext): Promise<CheckLine> {
  if (!isLinux(ctx)) return skip("system", "service", NOT_A_PI(ctx));
  const active = await ctx.run("systemctl", ["is-active", SERVICE_UNIT]);
  if (active.missing) return skip("system", "service", "systemctl is not installed");
  const enabled = await ctx.run("systemctl", ["is-enabled", SERVICE_UNIT]);
  const state = text(active).trim() || "unknown";
  const boot = text(enabled).trim() || "not installed";
  ctx.facts.serviceActive = state === "active" || state === "activating" || state === "reloading";
  const detail = `${SERVICE_UNIT} is ${state}, ${boot === "enabled" ? "starts at boot" : `boot: ${boot}`}`;
  if (boot !== "enabled") return fail("system", "service", `${detail}. Install it with scripts/install-pi.sh (README step 8)`);
  if (state === "active") return pass("system", "service", detail);
  if (state === "inactive") return warn("system", "service", `${detail}. Start it after this check: sudo systemctl start ${SERVICE_UNIT}`);
  return fail("system", "service", `${detail}. See journalctl -u ${SERVICE_UNIT} -b`);
}

export const systemCheck: Check = {
  name: "system",
  timeoutMs: 15_000,
  run: async (ctx) => [osLine(ctx), await clockLine(ctx), await throttleLine(ctx), memoryLine(ctx), await diskLine(ctx), await serviceLine(ctx)],
};

// ---- network ----

interface Route {
  dev: string;
  via: string | null;
  src: string | null;
  metric: number;
}

export function parseDefaultRoutes(output: string): Route[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("default"))
    .map((line) => {
      const field = (name: string) => new RegExp(`\\b${name} (\\S+)`).exec(line)?.[1] ?? null;
      return { dev: field("dev") ?? "?", via: field("via"), src: field("src"), metric: Number(field("metric") ?? 0) };
    })
    .sort((a, b) => a.metric - b.metric);
}

export async function routeLine(ctx: CheckContext): Promise<CheckLine> {
  if (!isLinux(ctx)) return skip("network", "default route", NOT_A_PI(ctx));
  const result = await ctx.run("ip", ["route", "show", "default"]);
  const problem = commandProblem("ip", result);
  if (problem) return fail("network", "default route", problem);
  const routes = parseDefaultRoutes(text(result));
  const first = routes[0];
  if (!first) return fail("network", "default route", "no default route: no network. Check the Ethernet cable and the switch port's light");
  const others = routes.slice(1).map((r) => `${r.dev} (metric ${r.metric})`);
  const detail = `${first.dev}${first.src ? ` ${first.src}` : ""}${first.via ? ` via ${first.via}` : ""}, metric ${first.metric}${others.length ? `; also ${others.join(", ")}` : ""}`;
  if (/^(eth|en)/.test(first.dev)) return pass("network", "default route", detail);
  if (/^wl/.test(first.dev)) return warn("network", "default route", `${detail}: Wi-Fi, but the venue plan is the Ethernet hardline`);
  return warn("network", "default route", detail);
}

/** Splits one `nmcli -t` line on unescaped colons; nmcli writes a `:` inside a value as `\:`. */
export function splitTerse(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === "\\" && i + 1 < line.length) {
      current += line[i + 1];
      i += 1;
    } else if (ch === ":") {
      fields.push(current);
      current = "";
    } else current += ch;
  }
  fields.push(current);
  return fields;
}

export async function wifiLine(ctx: CheckContext): Promise<CheckLine> {
  if (!isLinux(ctx)) return skip("network", "wifi autoconnect", NOT_A_PI(ctx));
  const result = await ctx.run("nmcli", ["-t", "-f", "NAME,TYPE,AUTOCONNECT", "connection", "show"]);
  if (result.missing) return skip("network", "wifi autoconnect", "nmcli is not installed");
  const problem = commandProblem("nmcli", result);
  if (problem) return fail("network", "wifi autoconnect", problem);
  const wifi = text(result)
    .split("\n")
    .filter(Boolean)
    .map(splitTerse)
    .filter(([, type]) => type === "802-11-wireless" || type === "wifi");
  const auto = wifi.filter(([, , autoconnect]) => autoconnect === "yes").map(([name]) => name!);
  if (auto.length === 0) return pass("network", "wifi autoconnect", `${wifi.length} Wi-Fi connection${wifi.length === 1 ? "" : "s"} saved, none autoconnects`);
  return warn(
    "network",
    "wifi autoconnect",
    `autoconnect on for ${auto.map((n) => `"${n}"`).join(", ")}: unplugging Ethernet would fail over to Wi-Fi instead of going offline (beat 6). ` +
      `To turn one off: sudo nmcli connection modify "<name>" connection.autoconnect no`,
  );
}

/** Placeholder, not measured: how long DNS and the health call may take (Render's free plan can sleep). */
export const DNS_TIMEOUT_MS = 5000;
export const HEALTH_TIMEOUT_MS = 20_000;

export interface NetworkDeps {
  lookup(host: string): Promise<string[]>;
  health(server: string, signal: AbortSignal): Promise<"ok" | "off" | "not_ready">;
  configuration(credential: CredentialFile, signal: AbortSignal): Promise<{ version: number; cues: readonly string[] }>;
}

export const realNetwork: NetworkDeps = {
  lookup: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
  health: checkHealth,
  configuration: (credential, signal) =>
    new HttpCloudClient(credential.server_url, credential.device_id, credential.credential).configuration(signal),
};

/** The credential file, read without changing it (the service's StateStore would fix its mode). */
export function readCredential(ctx: CheckContext): { credential: CredentialFile; mode: number | null } | { problem: string; missing: boolean } {
  const path = join(ctx.options.stateDir, "credential.json");
  const raw = ctx.files.read(path);
  if (raw === null) return { problem: `no ${path}`, missing: true };
  if (typeof raw !== "string") return { problem: `can't read ${path} (${raw.error}); run the check with sudo`, missing: false };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  const parsed = CredentialFileSchema.safeParse(json);
  if (!parsed.success) return { problem: `${path} is unreadable; pair again`, missing: false };
  return { credential: parsed.data, mode: ctx.files.mode(path) };
}

function serverFor(ctx: CheckContext): string | null {
  if (ctx.options.server) return ctx.options.server;
  const read = readCredential(ctx);
  return "credential" in read ? read.credential.server_url : null;
}

export async function dnsLine(ctx: CheckContext, net: NetworkDeps): Promise<CheckLine> {
  const server = serverFor(ctx);
  if (!server) return skip("network", "dns", "no server: pair first, or pass --server <url>");
  let host: string;
  try {
    host = new URL(server).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return fail("network", "dns", `not a URL: ${server}`);
  }
  try {
    const addresses = await withDeadline(ctx.clock, DNS_TIMEOUT_MS, () => net.lookup(host));
    return pass("network", "dns", `${host} → ${addresses.slice(0, 3).join(", ")}${addresses.length > 3 ? ` (+${addresses.length - 3})` : ""}`);
  } catch (error) {
    const reason = error instanceof Error && error.name === "DeadlineError" ? `no answer within ${DNS_TIMEOUT_MS / 1000} s` : ((error as NodeJS.ErrnoException).code ?? "failed");
    return fail("network", "dns", `${host}: ${reason}`);
  }
}

export async function healthLine(ctx: CheckContext, net: NetworkDeps): Promise<CheckLine> {
  const server = serverFor(ctx);
  if (!server) return skip("network", "server health", "no server: pair first, or pass --server <url>");
  const started = ctx.clock.monotonic();
  try {
    const health = await withDeadline(ctx.clock, HEALTH_TIMEOUT_MS, (signal) => net.health(server, signal));
    const ms = Math.round(ctx.clock.monotonic() - started);
    if (health === "ok") return pass("network", "server health", `${server}/api/v1/health ok in ${ms} ms`);
    if (health === "off") return fail("network", "server health", `${server} answers, but has walkers turned off`);
    return fail("network", "server health", `${server}/api/v1/health didn't answer ok (starting, or not the walker server) after ${ms} ms`);
  } catch (error) {
    const ms = Math.round(ctx.clock.monotonic() - started);
    if (error instanceof Error && error.name === "DeadlineError") {
      return fail("network", "server health", `${server}: no answer within ${HEALTH_TIMEOUT_MS / 1000} s (a sleeping Render server can take about a minute: run the check again)`);
    }
    const kind = error instanceof CloudError ? error.kind : error instanceof Error ? error.message : "failed";
    return fail("network", "server health", `${server}: ${kind} after ${ms} ms`);
  }
}

export function networkCheck(net: NetworkDeps = realNetwork): Check {
  return {
    name: "network",
    timeoutMs: 40_000,
    run: async (ctx) => [await routeLine(ctx), await wifiLine(ctx), await dnsLine(ctx, net), await healthLine(ctx, net)],
  };
}

// ---- pairing ----

export async function pairingLines(ctx: CheckContext, net: NetworkDeps): Promise<CheckLine[]> {
  if (!isLinux(ctx) && !ctx.options.stateDirGiven) {
    return [skip("pairing", "credential", `${NOT_A_PI(ctx)}; pass --state <dir> to check a simulator's pairing`)];
  }
  const read = readCredential(ctx);
  if ("problem" in read) {
    return [fail("pairing", "credential", read.missing ? `not paired: ${read.problem} (README step 9: walker pair <code> --server <url>)` : read.problem)];
  }
  const { credential, mode } = read;
  const where = `device ${credential.device_id} on ${credential.server_url}`;
  const lines: CheckLine[] = [];
  if (mode !== null && (mode & 0o077) !== 0) {
    lines.push(warn("pairing", "credential", `${where}; but the file is mode ${mode.toString(8)}, readable by others (the service sets it back to 600)`));
  } else lines.push(pass("pairing", "credential", `${where}${mode !== null ? `, mode ${mode.toString(8)}` : ""}`));
  // GET configuration is the one device route that changes nothing on the server (it reads the current one).
  try {
    const configuration = await withDeadline(ctx.clock, HEALTH_TIMEOUT_MS, (signal) => net.configuration(credential, signal));
    lines.push(pass("pairing", "server accepts", `configuration version ${configuration.version}, cues: ${configuration.cues.join(", ") || "none"}`));
  } catch (error) {
    if (error instanceof CloudError && error.kind === "unauthorized") {
      lines.push(fail("pairing", "server accepts", "the server doesn't know this walker's credential (forgotten on the page, or another server): pair again"));
    } else {
      const reason = error instanceof Error && error.name === "DeadlineError" ? `no answer within ${HEALTH_TIMEOUT_MS / 1000} s` : error instanceof CloudError ? `${error.kind}${error.status ? ` (${error.status})` : ""}` : "failed";
      lines.push(fail("pairing", "server accepts", `couldn't ask the server: ${reason}`));
    }
  }
  return lines;
}

export function pairingCheck(net: NetworkDeps = realNetwork): Check {
  return { name: "pairing", timeoutMs: 25_000, run: (ctx) => pairingLines(ctx, net) };
}
