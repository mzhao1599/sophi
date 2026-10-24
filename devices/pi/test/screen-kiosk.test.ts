import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Rows V1–V9 (test/EXPECTED.md): scripts/screen-display.sh on a temporary boot folder,
 * scripts/sophi-screen-wait.sh on a fake /sys/class/drm with a fake `curl`, and install-pi.sh with fake system
 * commands. Nothing here touches a real boot partition, display, network or system setting.
 */

const DISPLAY = fileURLToPath(new URL("../scripts/screen-display.sh", import.meta.url));
const WAIT = fileURLToPath(new URL("../scripts/sophi-screen-wait.sh", import.meta.url));
const INSTALL = fileURLToPath(new URL("../scripts/install-pi.sh", import.meta.url));
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// Raspberry Pi OS's stock files, from pi-gen (master, stage1/00-boot-files), with a real root in place of
// pi-gen's ROOTDEV placeholder and without the first-boot "resize".
const STOCK_CONFIG = `# For more options and information see
# http://rptl.io/configtxt
# Some settings may impact device functionality. See link above for details

# Uncomment some or all of these to enable the optional hardware interfaces
#dtparam=i2c_arm=on
#dtparam=i2s=on
#dtparam=spi=on

# Enable audio (loads snd_bcm2835)
dtparam=audio=on

# Additional overlays and parameters are documented
# /boot/firmware/overlays/README

# Automatically load overlays for detected cameras
camera_auto_detect=1

# Automatically load overlays for detected DSI displays
display_auto_detect=1

# Automatically load initramfs files, if found
auto_initramfs=1

# Enable DRM VC4 V3D driver
dtoverlay=vc4-kms-v3d
max_framebuffers=2

# Don't have the firmware create an initial video= setting in cmdline.txt.
# Use the kernel's default instead.
disable_fw_kms_setup=1

# Disable compensation for displays with overscan
disable_overscan=1

# Run as fast as firmware / board allows
arm_boost=1

[cm4]
# Enable host mode on the 2711 built-in XHCI USB controller.
# This line should be removed if the legacy DWC2 controller is required
# (e.g. for USB device mode) or if USB support is not required.
otg_mode=1

[cm5]
dtoverlay=dwc2,dr_mode=host

[pi5]
dtoverlay=nospi10

[all]
`;
const STOCK_CMDLINE =
  "console=serial0,115200 console=tty1 root=PARTUUID=1a2b3c4d-02 rootfstype=ext4 fsck.repair=yes rootwait cfg80211.ieee80211_regdom=US\n";
const OURS = "video=HDMI-A-1:800x480M@60 video=HDMI-A-2:800x480M@60 consoleblank=0";
const BEGIN = "# >>> Sophi screen: added by scripts/screen-display.sh (install-pi.sh --screen)";

const RECORD = "sophi-screen-added.txt";
const RECORD_HEADER = "# Kernel arguments scripts/screen-display.sh added to cmdline.txt; --remove takes out only these.";

function bootFolder(config: string | null, cmdline: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "sophi-boot-"));
  if (config !== null) writeFileSync(join(dir, "config.txt"), config);
  if (cmdline !== null) writeFileSync(join(dir, "cmdline.txt"), cmdline);
  const run = (...flags: string[]) => spawnSync("bash", [DISPLAY, ...flags, dir], { encoding: "utf8" });
  const file = (name: string) => readFileSync(join(dir, name), "utf8");
  const backups = () => readdirSync(dir).filter((name) => name.includes(".sophi-backup-")).sort();
  const hasRecord = () => existsSync(join(dir, RECORD));
  return { dir, run, file, backups, hasRecord };
}
const lastLine = (text: string) => text.trimEnd().split("\n").at(-1) ?? "";

describe("screen-display.sh", { timeout: 30_000 }, () => {
  it("V1, V2: stock files gain the video= and consoleblank arguments, config.txt is left alone, a second run changes nothing", () => {
    const boot = bootFolder(STOCK_CONFIG, STOCK_CMDLINE);
    const first = boot.run();
    expect(first.status, first.stderr).toBe(0);
    expect(boot.file("cmdline.txt")).toBe(`${STOCK_CMDLINE.trimEnd()} ${OURS}\n`);
    expect(boot.file("cmdline.txt").split("\n").filter((l) => l !== "")).toHaveLength(1);
    expect(boot.file("config.txt")).toBe(STOCK_CONFIG);
    expect(boot.file(RECORD)).toBe(`${RECORD_HEADER}\n${OURS.split(" ").join("\n")}\n`);
    const backups = boot.backups();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^cmdline\.txt\.sophi-backup-\d{8}-\d{6}$/);
    expect(boot.file(backups[0]!)).toBe(STOCK_CMDLINE);

    const second = boot.run();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("nothing to change");
    expect(boot.file("cmdline.txt")).toBe(`${STOCK_CMDLINE.trimEnd()} ${OURS}\n`);
    expect(boot.file("config.txt")).toBe(STOCK_CONFIG);
    expect(boot.file(RECORD)).toBe(`${RECORD_HEADER}\n${OURS.split(" ").join("\n")}\n`);
    expect(boot.backups()).toEqual(backups);
  });

  const OLD_CMDLINE =
    "console=tty1 video=HDMI-A-1:1024x768@60 root=PARTUUID=1a2b3c4d-02 consoleblank=600 video=DSI-1:800x480@60 rootwait\n";
  const CONFIG_WITHOUT_SETTING = STOCK_CONFIG.replace("disable_fw_kms_setup=1\n", "");
  const CONFIG_SETTING_ONLY_FOR_CM4 = CONFIG_WITHOUT_SETTING.replace("otg_mode=1\n", "otg_mode=1\ndisable_fw_kms_setup=1\n");

  it("V3: other HDMI modes and consoleblank are replaced, other video= kept, and config.txt gains one block", () => {
    for (const startConfig of [CONFIG_WITHOUT_SETTING, CONFIG_SETTING_ONLY_FOR_CM4]) {
      const boot = bootFolder(startConfig, OLD_CMDLINE);
      const first = boot.run();
      expect(first.status, first.stderr).toBe(0);
      expect(boot.file("cmdline.txt")).toBe(
        `console=tty1 root=PARTUUID=1a2b3c4d-02 video=DSI-1:800x480@60 rootwait ${OURS}\n`,
      );
      const config = boot.file("config.txt");
      expect(config.startsWith(startConfig)).toBe(true);
      expect(config.slice(startConfig.length).split("\n")).toEqual([
        BEGIN,
        "[all]",
        "# Don't let the firmware pass its own video= from the panel's EDID: cmdline.txt's video= decides.",
        "disable_fw_kms_setup=1",
        "# <<< Sophi screen",
        "",
      ]);
      const backups = boot.backups();
      expect(backups.map((name) => name.split(".sophi-backup-")[0])).toEqual(["cmdline.txt", "config.txt"]);
      expect(boot.file(backups.find((name) => name.startsWith("config.txt"))!)).toBe(startConfig);

      const second = boot.run();
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain("nothing to change");
      expect(boot.file("config.txt")).toBe(config);
      expect(config.split(BEGIN)).toHaveLength(2);
      expect(boot.backups()).toEqual(backups);
    }
  });

  it("V3: the setting under [all], after model sections, counts as present", () => {
    const config = `${CONFIG_WITHOUT_SETTING}disable_fw_kms_setup=1\n`;
    const boot = bootFolder(config, STOCK_CMDLINE);
    expect(boot.run().status).toBe(0);
    expect(boot.file("config.txt")).toBe(config);
  });

  it("V4: --force-on forces HDMI0 on, and a later run without it keeps the D", () => {
    const boot = bootFolder(STOCK_CONFIG, STOCK_CMDLINE);
    expect(boot.run("--force-on").status).toBe(0);
    const forced = `${STOCK_CMDLINE.trimEnd()} video=HDMI-A-1:800x480M@60D video=HDMI-A-2:800x480M@60 consoleblank=0\n`;
    expect(boot.file("cmdline.txt")).toBe(forced);
    const again = boot.run();
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("nothing to change");
    expect(boot.file("cmdline.txt")).toBe(forced);
  });

  it("V5: --remove takes out exactly what was added, with backups", () => {
    const boot = bootFolder(CONFIG_WITHOUT_SETTING, OLD_CMDLINE);
    expect(boot.run().status).toBe(0);
    expect(boot.run("--force-on").status).toBe(0);
    const before = boot.backups().length;
    const removed = boot.run("--remove");
    expect(removed.status, removed.stderr).toBe(0);
    expect(boot.file("config.txt")).toBe(CONFIG_WITHOUT_SETTING);
    // consoleblank=600 was replaced: it is only in the first backup, as the README says.
    expect(boot.file("cmdline.txt")).toBe("console=tty1 root=PARTUUID=1a2b3c4d-02 video=DSI-1:800x480@60 rootwait\n");
    expect(boot.hasRecord()).toBe(false);
    expect(boot.backups().length).toBe(before + 2);
    expect(boot.run("--remove").stdout).toContain("nothing to change");
  });

  it("V5: --remove keeps a consoleblank=0 (and our own video= form) that was there before the first run", () => {
    const mine = "console=tty1 root=PARTUUID=1a2b3c4d-02 consoleblank=0 video=HDMI-A-2:800x480M@60 rootwait\n";
    const boot = bootFolder(STOCK_CONFIG, mine);
    expect(boot.run().status).toBe(0);
    expect(boot.file(RECORD)).toBe(`${RECORD_HEADER}\nvideo=HDMI-A-1:800x480M@60\n`);
    expect(boot.run("--remove").status).toBe(0);
    expect(boot.file("cmdline.txt")).toBe(
      "console=tty1 root=PARTUUID=1a2b3c4d-02 rootwait video=HDMI-A-2:800x480M@60 consoleblank=0\n",
    );
    expect(boot.hasRecord()).toBe(false);
  });

  it("V6: a missing file, a config.txt without the KMS driver, or a cmdline.txt that doesn't look right changes nothing", () => {
    for (const [config, cmdline] of [
      [STOCK_CONFIG, null],
      [null, STOCK_CMDLINE],
      [STOCK_CONFIG.replace("dtoverlay=vc4-kms-v3d\n", ""), STOCK_CMDLINE],
      [STOCK_CONFIG.replace("dtoverlay=vc4-kms-v3d\n", "").replace("[pi5]\n", "[pi5]\ndtoverlay=vc4-kms-v3d\n"), STOCK_CMDLINE],
      [STOCK_CONFIG, "console=tty1 rootfstype=ext4 rootwait\n"],
      [STOCK_CONFIG, `${STOCK_CMDLINE}quiet splash\n`],
      [STOCK_CONFIG, ""],
    ] as const) {
      const boot = bootFolder(config, cmdline);
      const result = boot.run();
      expect(result.status).not.toBe(0);
      expect(lastLine(result.stderr)).toMatch(/Nothing was changed\.$/);
      if (config !== null) expect(boot.file("config.txt")).toBe(config);
      if (cmdline !== null) expect(boot.file("cmdline.txt")).toBe(cmdline);
      expect(boot.backups()).toEqual([]);
      expect(boot.hasRecord()).toBe(false);
    }
  });
});

function waitSetup(status: "connected" | "disconnected" | null) {
  const dir = mkdtempSync(join(tmpdir(), "sophi-wait-"));
  const drm = join(dir, "drm");
  mkdirSync(join(drm, "card1-HDMI-A-1"), { recursive: true });
  mkdirSync(join(drm, "card1-HDMI-A-2"), { recursive: true });
  writeFileSync(join(drm, "card1-HDMI-A-2", "status"), "disconnected\n");
  if (status) writeFileSync(join(drm, "card1-HDMI-A-1", "status"), `${status}\n`);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "curl.log");
  writeFileSync(log, "");
  const curl = join(bin, "curl");
  // Records its arguments; succeeds only when the file named by CURL_OK exists.
  writeFileSync(curl, `#!/bin/sh\nprintf '%s\\n' "$*" >>"$CURL_LOG"\n[ -e "$CURL_OK" ]\n`);
  chmodSync(curl, 0o755);
  const ok = join(dir, "curl-ok");
  const page = join(dir, "placeholder.html");
  writeFileSync(page, "<!doctype html>");
  // The "kiosk" the script should start: prints its arguments.
  const kiosk = ["/bin/echo", "KIOSK", "--kiosk"];
  const run = (url: string, limit: string | null = "0", timeout?: number) =>
    spawnSync("bash", [WAIT, ...kiosk], {
      encoding: "utf8",
      timeout,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        SOPHI_SCREEN_URL: url,
        ...(limit === null ? {} : { SOPHI_SCREEN_WAIT_SECONDS: limit }),
        SOPHI_SCREEN_DRM_DIR: drm,
        CURL_LOG: log,
        CURL_OK: ok,
      },
    });
  const curlCalls = () => readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
  return { page, ok, run, curlCalls };
}

describe("sophi-screen-wait.sh", { timeout: 30_000 }, () => {
  it("V7: a local file page with a connected screen starts the kiosk at once, without curl", () => {
    const w = waitSetup("connected");
    const result = w.run(`file://${w.page}`);
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain("KIOSK --kiosk\n");
    expect(w.curlCalls()).toEqual([]);
  });

  it("V7: no connected screen means waiting; with a limit it gives up without starting the kiosk", () => {
    for (const status of ["disconnected", null] as const) {
      const w = waitSetup(status);
      const result = w.run(`file://${w.page}`);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("no screen is connected");
      expect(result.stdout).not.toContain("KIOSK");
    }
  });

  it("V7: without a limit it keeps waiting, saying so once", () => {
    const w = waitSetup("disconnected");
    const result = w.run(`file://${w.page}`, null, 2500);
    expect(result.signal).toBe("SIGTERM");
    expect(result.stdout.match(/Waiting: no screen is connected/g)).toHaveLength(1);
    expect(result.stdout).not.toContain("KIOSK");
  });

  it("V7: the walker service's page on 127.0.0.1 is waited for until it answers", () => {
    const w = waitSetup("connected");
    const url = "http://127.0.0.1:8737/";
    const before = w.run(url);
    expect(before.status).toBe(1);
    expect(before.stdout).toContain("doesn't answer yet");
    expect(before.stdout).not.toContain("KIOSK");
    writeFileSync(w.ok, "");
    const after = w.run(url);
    expect(after.status, after.stdout).toBe(0);
    expect(after.stdout).toContain("KIOSK --kiosk\n");
    expect(w.curlCalls().every((call) => call.endsWith(url))).toBe(true);
  });

  it("V7: any other address is refused without calling curl or starting the kiosk", () => {
    const w = waitSetup("connected");
    writeFileSync(w.ok, "");
    for (const url of ["https://example.com/", "http://127.0.0.1:1@example.com/", "http://localhost.example.com/", ""]) {
      const result = w.run(url);
      expect(result.status, url).toBe(1);
      expect(result.stdout).toContain("only local pages");
      expect(result.stdout).not.toContain("KIOSK");
    }
    expect(w.curlCalls()).toEqual([]);
  });
});

describe("the screen's unit files and placeholder", () => {
  const walkerUnit = read("../systemd/steady-walker.service");
  const screenUnit = read("../systemd/sophi-screen.service");
  const directives = (unit: string) => unit.split("\n").filter((line) => !line.startsWith("#"));

  it("V8: neither unit depends on the other, and boot never waits for the screen", () => {
    expect(walkerUnit).not.toMatch(/sophi-screen/);
    const text = directives(screenUnit).join("\n");
    expect(text).not.toMatch(/^(Requires|BindsTo|PartOf|Requisite)=/m);
    expect(text).not.toMatch(/steady-walker\.service/);
    expect(text).not.toMatch(/^ExecStartPre=/m);
    expect(text).toMatch(/^ExecStart=\/opt\/steady-walker\/screen\/sophi-screen-wait\.sh \/usr\/bin\/cage /m);
  });

  it("V8: restarts for ever with a back-off, keeps the profile in /run, and is the first to go when memory runs out", () => {
    const lines = directives(screenUnit);
    expect(lines).toContain("Restart=always");
    expect(lines).toContain("StartLimitIntervalSec=0");
    expect(lines).toContain("RestartSec=5");
    expect(lines).toContain("RestartSteps=6");
    expect(lines).toContain("RestartMaxDelaySec=120");
    expect(screenUnit).toContain("--user-data-dir=/run/sophi-screen/chromium");
    const oom = lines.find((line) => line.startsWith("OOMScoreAdjust="));
    expect(Number(oom?.split("=")[1])).toBeGreaterThan(0);
  });

  it("V8: the placeholder says only what is true", () => {
    const page = read("../screen/placeholder.html");
    expect(page).toContain("<h1>Sophi</h1>");
    const text = page.replace(/<script>[\s\S]*<\/script>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Screen connected. Waiting for the walker service.");
    // It goes to the walker service's own page, on 127.0.0.1 only, once that answers.
    expect(page).toContain('var page = "http://127.0.0.1:8740/";');
  });
});

/**
 * V9: the whole installer with every system command it calls replaced by a fake. The fakes that would change
 * the system (install, useradd, usermod, udevadm, systemctl, journalctl, ln) only append "name args" to a log.
 */
function installerSetup(boot: { config: string | null; cmdline: string | null }, screenBins = ["cage", "chromium"]) {
  const dir = mkdtempSync(join(tmpdir(), "sophi-install-"));
  const bin = join(dir, "bin");
  const screenBin = join(dir, "usr-bin");
  const bootDir = join(dir, "boot");
  mkdirSync(bin);
  mkdirSync(screenBin);
  mkdirSync(bootDir);
  if (boot.config !== null) writeFileSync(join(bootDir, "config.txt"), boot.config);
  if (boot.cmdline !== null) writeFileSync(join(bootDir, "cmdline.txt"), boot.cmdline);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const fake = (folder: string, name: string, body: string) => {
    writeFileSync(join(folder, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(folder, name), 0o755);
  };
  for (const name of ["install", "useradd", "usermod", "udevadm", "systemctl", "journalctl", "ln"]) {
    fake(bin, name, `echo "${name} $*" >>"$CALLS_LOG"`);
  }
  // `id -u` says root; `id -u <user>` says the user exists.
  fake(bin, "id", `if [ "$#" = 1 ] && [ "$1" = -u ]; then echo 0; fi`);
  fake(bin, "node", "echo 22");
  fake(bin, "getent", "exit 0");
  for (const name of ["arecord", "aplay", "stty", "gpiomon", "espeak-ng", "curl"]) fake(bin, name, "exit 0");
  for (const name of screenBins) fake(screenBin, name, "exit 0");
  const bundle = join(dir, "walker.mjs");
  writeFileSync(bundle, "// bundle");
  const run = (...args: string[]) =>
    spawnSync("bash", [INSTALL, ...args.map((a) => (a === "BUNDLE" ? bundle : a))], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        CALLS_LOG: log,
        WALKER_BOOT_DIR: bootDir,
        WALKER_SCREEN_BIN_DIR: screenBin,
      },
    });
  const calls = () => readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
  const bootFile = (name: string) => readFileSync(join(bootDir, name), "utf8");
  return { run, calls, bootFile };
}

describe("install-pi.sh --screen", { timeout: 30_000 }, () => {
  it("V9: a failing screen step leaves the walker installed and enabled, says why, and exits 0", () => {
    const inst = installerSetup({ config: STOCK_CONFIG, cmdline: null });
    const result = inst.run("--screen", "BUNDLE");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Screen not installed: No .*cmdline\.txt: .*Nothing was changed\./);
    const calls = inst.calls();
    expect(calls).toContain("systemctl daemon-reload");
    expect(calls).toContain("systemctl enable walker-wifi.service steady-walker.service");
    expect(calls.join("\n")).not.toContain("sophi-screen");
    expect(inst.bootFile("config.txt")).toBe(STOCK_CONFIG);
  });

  it("V9: --screen after the bundle path works, and enables the screen after the walker", () => {
    const inst = installerSetup({ config: STOCK_CONFIG, cmdline: STOCK_CMDLINE });
    const result = inst.run("BUNDLE", "--screen");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("Screen not installed");
    const calls = inst.calls();
    const walker = calls.indexOf("systemctl enable walker-wifi.service steady-walker.service");
    const screen = calls.indexOf("systemctl enable sophi-screen.service");
    expect(walker).toBeGreaterThanOrEqual(0);
    expect(screen).toBeGreaterThan(walker);
    expect(calls).toContain(
      `install -m 0644 ${fileURLToPath(new URL("../systemd/sophi-screen.service", import.meta.url))} /etc/systemd/system/sophi-screen.service`,
    );
    expect(inst.bootFile("cmdline.txt")).toBe(`${STOCK_CMDLINE.trimEnd()} ${OURS}\n`);
  });

  it("V9: without --screen the boot folder's settings are never touched", () => {
    const inst = installerSetup({ config: STOCK_CONFIG, cmdline: STOCK_CMDLINE });
    const result = inst.run("BUNDLE");
    expect(result.status, result.stderr).toBe(0);
    expect(inst.bootFile("cmdline.txt")).toBe(STOCK_CMDLINE);
    expect(inst.bootFile("config.txt")).toBe(STOCK_CONFIG);
    expect(inst.calls().join("\n")).not.toContain("sophi-screen");
  });

  it("V9: an unknown option, an extra argument, or a missing cage or chromium stops before changing anything", () => {
    for (const args of [["--scren", "BUNDLE"], ["BUNDLE", "extra"], ["BUNDLE", "--screen", "BUNDLE"]]) {
      const inst = installerSetup({ config: STOCK_CONFIG, cmdline: STOCK_CMDLINE });
      const result = inst.run(...args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(inst.calls()).toEqual([]);
    }
    for (const present of [["cage"], ["chromium"]]) {
      const inst = installerSetup({ config: STOCK_CONFIG, cmdline: STOCK_CMDLINE }, present);
      const result = inst.run("--screen", "BUNDLE");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("needed for --screen");
      expect(inst.calls()).toEqual([]);
      expect(inst.bootFile("cmdline.txt")).toBe(STOCK_CMDLINE);
    }
  });
});
