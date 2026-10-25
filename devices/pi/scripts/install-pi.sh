#!/usr/bin/env bash
# Installs Sophi's walker service on a Raspberry Pi. Ran as far as the walker service on a Pi 5 with
# Raspberry Pi OS trixie on 2026-10-23, and again with the Wi-Fi part the same night.
# Usage, on the Pi, from a copy of devices/pi: sudo ./scripts/install-pi.sh dist/walker.mjs
# What it does: creates the `steady` system user, copies the bundle to /opt/steady-walker, creates the
# 0700 state folder, installs the systemd unit and (only if missing) /etc/steady-walker.env, and enables
# the service. It also installs the Wi-Fi helpers (walker-wifi.service reads the SD card's wifi.txt at
# boot; `sudo walker-wifi-add.sh` adds a network over SSH) and puts the instructions file on the card if
# it has none. It also installs four small system settings from systemd/ (README, "Set up the Pi"): the
# soundbar's udev name, its volume (75%) at each service start, a journal kept across power-offs, and a
# power button that ignores a short press. Those four were set by hand on the Pi on 2026-10-23 with the
# same contents, then this script installed them over those on the same Pi (2026-10-23, 23:28). It does not pair the walker or
# start the service.
# With --screen (sudo ./scripts/install-pi.sh --screen dist/walker.mjs, in either order) it then also sets up
# the walker's 800x480 HDMI touch screen with scripts/install-screen.sh (README, "The screen"), after the
# walker service is installed and enabled. If that fails, it says "Screen not installed: <reason>" and the
# walker install still stands. Without --screen it never touches display settings. The --screen part was
# written 2026-10-23 and has not been run on the Pi yet.
# WALKER_BOOT_DIR and WALKER_SCREEN_BIN_DIR are changed only by test/screen-kiosk.test.ts.
set -euo pipefail

usage() {
  echo "Usage: sudo $0 [--screen] <path to dist/walker.mjs>" >&2
  exit 2
}
screen=0
bundle=""
for arg in "$@"; do
  case "$arg" in
    --screen) screen=1 ;;
    -*) echo "Unknown option: $arg" >&2; usage ;;
    *) if [[ -n "$bundle" ]]; then echo "Unexpected argument: $arg" >&2; usage; fi; bundle="$arg" ;;
  esac
done
here="$(cd "$(dirname "$0")/.." && pwd)"
boot="${WALKER_BOOT_DIR:-/boot/firmware}"
bin_dir="${WALKER_SCREEN_BIN_DIR:-/usr/bin}"
if [[ -z "$bundle" || ! -f "$bundle" ]]; then
  usage
fi
if [[ "$(id -u)" != 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi
if ! command -v node >/dev/null; then
  echo "Node is not installed. Install Node 22 first (README step 2)." >&2
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if (( major < 22 )); then
  echo "Node $major found; Node 22 or newer is needed (README step 2)." >&2
  exit 1
fi
missing=()
for tool in arecord aplay stty gpiomon espeak-ng; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if (( ${#missing[@]} > 0 )); then
  echo "Missing: ${missing[*]}. Install with: sudo apt install alsa-utils gpiod espeak-ng" >&2
  exit 1
fi
if (( screen )); then
  # The paths sophi-screen.service runs, checked before anything is changed.
  for tool in "$bin_dir/cage" "$bin_dir/chromium"; do
    if [[ ! -x "$tool" ]]; then
      echo "Missing: $tool, needed for --screen. Install with: sudo apt install cage chromium curl" >&2
      exit 1
    fi
  done
  if ! command -v curl >/dev/null; then
    echo "Missing: curl, needed for --screen. Install with: sudo apt install cage chromium curl" >&2
    exit 1
  fi
fi

id -u steady >/dev/null 2>&1 || useradd --system --home-dir /var/lib/steady-walker --shell /usr/sbin/nologin steady
# The live camera is optional: without ffmpeg, WALKER_CAMERA_DEVICE just logs that it can't start.
command -v ffmpeg >/dev/null || echo "Note: ffmpeg is missing; the live camera (WALKER_CAMERA_DEVICE) needs it. Install with: sudo apt install ffmpeg" >&2
for group in audio dialout gpio video; do
  if getent group "$group" >/dev/null; then usermod -aG "$group" steady; else echo "Note: no '$group' group on this system." >&2; fi
done

install -d -m 0755 /opt/steady-walker
install -m 0755 "$bundle" /opt/steady-walker/walker.mjs
# The walker screen's page, which the walker service serves on 127.0.0.1 (bundle.mjs builds it beside walker.mjs).
page="$(dirname "$bundle")/screen-page"
if [[ -f "$page/page.js" ]]; then
  install -d -m 0755 /opt/steady-walker/screen-page
  # The whole folder, subfolders too, readable by the service.
  cp -R "$page/." /opt/steady-walker/screen-page/
  chmod -R u=rwX,go=rX /opt/steady-walker/screen-page
else
  echo "Note: no screen-page folder beside $bundle, so the walker runs without its screen page." >&2
fi
install -d -m 0700 -o steady -g steady /var/lib/steady-walker
if [[ ! -f /etc/steady-walker.env ]]; then
  install -m 0640 -o root -g steady "$here/systemd/steady-walker.env.example" /etc/steady-walker.env
  echo "Wrote /etc/steady-walker.env from the example: edit the ALSA names and pins before starting."
fi
install -m 0644 "$here/systemd/steady-walker.service" /etc/systemd/system/steady-walker.service
# Our soundbar at 75% volume each time the service starts (it came up at 30%; Max chose 75%).
install -d -m 0755 /etc/systemd/system/steady-walker.service.d
install -m 0644 "$here/systemd/steady-walker.service.d/10-volume.conf" /etc/systemd/system/steady-walker.service.d/10-volume.conf

# Our soundbar's ALSA card is always called "Speaker" (applies when it's next plugged in, or at boot).
install -m 0644 "$here/systemd/85-walker-audio.rules" /etc/udev/rules.d/85-walker-audio.rules
udevadm control --reload-rules

# Keep the journal across power-offs (Raspberry Pi OS keeps it in memory only).
install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 "$here/systemd/journald-walker.conf" /etc/systemd/journald.conf.d/90-walker-persistent.conf
systemctl restart systemd-journald
journalctl --flush

# A short press of the Pi 5's power button does nothing (holding it ~10 s still forces it off).
install -d -m 0755 /etc/systemd/logind.conf.d
install -m 0644 "$here/systemd/logind-walker.conf" /etc/systemd/logind.conf.d/90-walker-power-key.conf
systemctl kill -s HUP systemd-logind

# Wi-Fi on any network: wifi.txt on the card's boot partition (editable from any computer), read at boot.
install -m 0755 "$here/scripts/walker-wifi-import.sh" /opt/steady-walker/walker-wifi-import.sh
install -m 0755 "$here/scripts/walker-wifi-add.sh" /opt/steady-walker/walker-wifi-add.sh
ln -sf /opt/steady-walker/walker-wifi-add.sh /usr/local/sbin/walker-wifi-add.sh
install -m 0644 "$here/systemd/walker-wifi.service" /etc/systemd/system/walker-wifi.service
if [[ ! -d "$boot" ]]; then
  echo "Note: no $boot on this system, so no wifi.txt was put on the card." >&2
elif [[ ! -f "$boot/wifi.txt" ]]; then
  # Plain cp: the boot partition is FAT, which can't take the file modes `install` would set.
  cp "$here/systemd/wifi.txt.example" "$boot/wifi.txt"
  echo "Wrote $boot/wifi.txt: add Wi-Fi networks there from any computer (README, \"Wi-Fi on any network\")."
fi

systemctl daemon-reload
systemctl enable walker-wifi.service steady-walker.service
echo "Installed and enabled (not started). Next: edit /etc/steady-walker.env, pair, then sudo systemctl start steady-walker."

# The screen (only with --screen), after the walker is installed and enabled, so a screen problem never
# leaves the walker half-installed. It runs as its own process, which stops at its own first failure.
if (( screen )); then
  if output="$(WALKER_SCREEN_BIN_DIR="$bin_dir" "$here/scripts/install-screen.sh" "$boot" 2>&1)"; then
    printf '%s\n' "$output"
  else
    printf '%s\n' "$output"
    echo "Screen not installed: $(printf '%s\n' "$output" | grep -v '^[[:space:]]*$' | tail -n 1)" >&2
    echo "The walker service is installed. Fix that, then run: sudo ./scripts/install-screen.sh" >&2
  fi
fi
