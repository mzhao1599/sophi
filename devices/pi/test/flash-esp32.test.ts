import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Rows F1–F7 (test/EXPECTED.md): scripts/flash-esp32.sh, run with bash against fake `systemctl`, `fuser`
 * and `esptool` that only record their arguments, so no test touches a board or the Mac's services.
 */

const SCRIPT = fileURLToPath(new URL("../scripts/flash-esp32.sh", import.meta.url));
const SEP = "\u001f";

function setup(options: { esptoolVersion?: string; serviceActive?: boolean; portBusy?: boolean | "exit-0-no-holders"; ports?: string[]; image?: Record<string, string> | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "walker-flash-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const fake = (name: string, exitCode: number, stdout = "") => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n(IFS="$(printf '\\037')"; printf '%s\\n' "${name}$(printf '\\037')$*") >>"$CALLS_LOG"\nprintf '%s' '${stdout}'\nexit ${exitCode}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  fake("systemctl", options.serviceActive ? 0 : 3);
  // Like psmisc's fuser: the holders' process ids on stdout (and exit 1 with none).
  fake("fuser", options.portBusy ? 0 : 1, options.portBusy === true ? " 4242" : "");
  const esptool = fake("esptool-fake", 0, options.esptoolVersion ?? "esptool v5.6.0");
  const serial = join(dir, "by-id");
  mkdirSync(serial);
  for (const name of options.ports ?? ["usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0"]) writeFileSync(join(serial, name), "");
  const images = join(dir, "firmware");
  const image = options.image === undefined ? { "bootloader.bin": "boot", "partitions.bin": "parts", "boot_app0.bin": "app0", "firmware.bin": "\u0000\u0001hand-right-01\u0000rest" } : options.image;
  if (image) {
    mkdirSync(join(images, "hand-right-01"), { recursive: true });
    for (const [name, contents] of Object.entries(image)) writeFileSync(join(images, "hand-right-01", name), contents);
  }
  const run = (...args: string[]) => {
    const result = spawnSync("bash", [SCRIPT, ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, CALLS_LOG: log, ESPTOOL: esptool, WALKER_SERIAL_DIR: serial, WALKER_FIRMWARE_DIR: images },
      encoding: "utf8",
    });
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split(SEP));
    // The flash itself; the script first asks `esptool version` to pick the command's spelling.
    const esptoolCalls = calls.filter((c) => c[0] === "esptool-fake" && c[1] !== "version");
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, esptool: esptoolCalls };
  };
  return { run, serial, images, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("flash-esp32.sh", { timeout: 30_000 }, () => {
  it("F6, F5: with everything in place, one esptool call with the four files at their addresses", () => {
    const s = setup();
    const result = s.run("hand-right-01");
    expect(result.status, result.stderr).toBe(0);
    expect(result.esptool).toEqual([[
      "esptool-fake", "--chip", "esp32", "--port", join(s.serial, "usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0"),
      "--baud", "460800", "write-flash", "0x1000", "bootloader.bin", "0x8000", "partitions.bin", "0xe000", "boot_app0.bin", "0x10000", "firmware.bin",
    ]]);
    expect(result.stdout).toContain(`Flashing hand-right-01 from ${join(s.images, "hand-right-01")}`);
    s.cleanup();
    // esptool 4 (PlatformIO's 4.9.0) only knows write_flash.
    const old = setup({ esptoolVersion: "esptool.py v4.9.0\n4.9.0" });
    expect(old.run("hand-right-01").esptool[0]).toContain("write_flash");
    old.cleanup();
  });

  it("F1: refuses while the walker service is running, and never stops it", () => {
    const s = setup({ serviceActive: true });
    const result = s.run("hand-right-01");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sudo systemctl stop steady-walker");
    expect(result.esptool).toEqual([]);
    expect(result.calls).toEqual([["systemctl", "is-active", "--quiet", "steady-walker"]]);
    s.cleanup();
  });

  it("F2: refuses when another program holds the port", () => {
    const s = setup({ portBusy: true });
    const result = s.run("hand-right-01");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Another program (process 4242) has");
    expect(result.esptool).toEqual([]);
    s.cleanup();
    // macOS's fuser exits 0 even when nothing holds the file: only process ids on stdout count.
    const mac = setup({ portBusy: "exit-0-no-holders" });
    expect(mac.run("hand-right-01").status).toBe(0);
    mac.cleanup();
  });

  it("F3: refuses when the image folder or one of its files is missing", () => {
    const none = setup({ image: null });
    expect(none.run("hand-right-01")).toMatchObject({ status: 1, stderr: expect.stringContaining("Missing"), esptool: [] });
    none.cleanup();
    const partial = setup({ image: { "bootloader.bin": "b", "partitions.bin": "p", "firmware.bin": "hand-right-01" } });
    const result = partial.run("hand-right-01");
    expect(result).toMatchObject({ status: 1, esptool: [] });
    expect(result.stderr).toContain("hand-right-01/boot_app0.bin");
    partial.cleanup();
  });

  it("F4: refuses an image built for another board", () => {
    const s = setup({ image: { "bootloader.bin": "b", "partitions.bin": "p", "boot_app0.bin": "a", "firmware.bin": "\u0000hand-left-01\u0000" } });
    const result = s.run("hand-right-01");
    expect(result).toMatchObject({ status: 1, esptool: [] });
    expect(result.stderr).toContain("built for another board");
    s.cleanup();
  });

  it("F5: with two boards plugged in and no --port, refuses and lists them; --port picks one", () => {
    const s = setup({ ports: ["usb-board-a", "usb-board-b"] });
    const result = s.run("hand-right-01");
    expect(result).toMatchObject({ status: 1, esptool: [] });
    expect(result.stderr).toContain(join(s.serial, "usb-board-a"));
    expect(result.stderr).toContain(join(s.serial, "usb-board-b"));
    const chosen = s.run("hand-right-01", "--port", join(s.serial, "usb-board-b"));
    expect(chosen.status, chosen.stderr).toBe(0);
    expect(chosen.esptool[0]).toContain(join(s.serial, "usb-board-b"));
    s.cleanup();
  });

  it("F7: a bad id or no id prints the usage and exits 2", () => {
    const s = setup();
    for (const args of [[], ["any"], ["Hand-Right-01"], ["hand_right"], ["-hand"], ["hand-right-01", "--bogus"]]) {
      const result = s.run(...args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr).toContain("Usage:");
      expect(result.esptool).toEqual([]);
    }
    s.cleanup();
  });
});
