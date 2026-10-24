import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Rows W1–W6 (test/EXPECTED.md): scripts/walker-wifi-import.sh, run with bash against a fake `nmcli`
 * that only records its arguments (one call per line, arguments separated by a unit separator).
 */

const SCRIPT = fileURLToPath(new URL("../scripts/walker-wifi-import.sh", import.meta.url));
const SEP = "\u001f";

function setup(contents: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "walker-wifi-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "nmcli.log");
  writeFileSync(log, "");
  const nmcli = join(bin, "nmcli");
  writeFileSync(nmcli, `#!/bin/sh\n(IFS="$(printf '\\037')"; printf '%s\\n' "$*") >>"$NMCLI_LOG"\n`);
  chmodSync(nmcli, 0o755);
  const file = join(dir, "wifi.txt");
  if (contents !== null) writeFileSync(file, contents);
  const run = () => {
    const result = spawnSync("bash", [SCRIPT, file], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, NMCLI_LOG: log },
      encoding: "utf8",
    });
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split(SEP));
    writeFileSync(log, "");
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  };
  return { file, run };
}

const COMMON = ["connection.autoconnect", "yes", "ipv4.may-fail", "yes", "ipv6.method", "auto", "ipv6.may-fail", "yes"];
const addWpa = (ssid: string, password: string) => [
  "connection", "add", "type", "wifi", "ifname", "wlan0", "con-name", `walker: ${ssid}`, "ssid", ssid,
  "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", password, ...COMMON,
];
const addOpen = (ssid: string) => [
  "connection", "add", "type", "wifi", "ifname", "wlan0", "con-name", `walker: ${ssid}`, "ssid", ssid, ...COMMON,
];
const remove = (ssid: string) => ["connection", "delete", "id", `walker: ${ssid}`];

const EXAMPLE_HEADER = readFileSync(new URL("../systemd/wifi.txt.example", import.meta.url), "utf8");

// Each case runs the real script with bash several times; under CI load one case took 6.7 s, past the 5 s default.
describe("walker-wifi-import.sh", { timeout: 30_000 }, () => {
  it("W1–W6: adds each new block once, keeps comments and orphan lines, saves passwords, and a second run adds nothing", () => {
    const before = [
      EXAMPLE_HEADER.trimEnd(),
      "",
      "name: M’s Phone",
      "password: hunter2 with spaces",
      "",
      "name:   Max's Home Wi-Fi  ",
      "password:  p@ss:word#1  ",
      "",
      "name: Cafe Open",
      "password:",
      "",
      "name: Old Network",
      "password: (saved)",
      "# name: Commented Out",
      "password: orphan-pass",
      "",
      "Some note the user typed.",
      "",
    ].join("\n");
    const { file, run } = setup(before);

    const first = run();
    expect(first.status).toBe(0);
    expect(first.calls).toEqual([
      remove("M’s Phone"),
      addWpa("M’s Phone", "hunter2 with spaces"),
      remove("Max's Home Wi-Fi"),
      addWpa("Max's Home Wi-Fi", "p@ss:word#1"),
      remove("Cafe Open"),
      addOpen("Cafe Open"),
    ]);
    expect(first.stdout).not.toContain("hunter2");
    expect(first.stdout).not.toContain("p@ss");

    const after = readFileSync(file, "utf8");
    const expected = before
      .replace("password: hunter2 with spaces", "password: (saved)")
      .replace("password:  p@ss:word#1  ", "password: (saved)")
      .replace("name: Cafe Open\npassword:\n", "name: Cafe Open\npassword: (saved)\n");
    expect(after).toBe(expected);
    expect(after).toContain("# name: Example Network\n# password: example-password\n");

    const second = run();
    expect(second.status).toBe(0);
    expect(second.calls).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(expected);
  });

  it("W5: a file saved with Windows line endings parses the same, and its other lines keep their CRLF", () => {
    const { file, run } = setup("# my networks\r\nname: Home Net\r\npassword: secret123\r\n");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([remove("Home Net"), addWpa("Home Net", "secret123")]);
    expect(readFileSync(file, "utf8")).toBe("# my networks\r\nname: Home Net\r\npassword: (saved)\n");
    expect(run().calls).toEqual([]);
  });

  it("W6: a missing wifi.txt exits 0 without calling nmcli", () => {
    const { file, run } = setup(null);
    const result = run();
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });
});
