#!/usr/bin/env bash
# Installs Steady's walker service on a Raspberry Pi. Ran as far as the walker service on a Pi 5 with
# Raspberry Pi OS trixie on 2026-10-24, and again with the Wi-Fi part the same night.
# Usage, on the Pi, from a copy of devices/pi: sudo ./scripts/install-pi.sh dist/walker.mjs
# What it does: creates the `steady` system user, copies the bundle to /opt/steady-walker, creates the
# 0700 state folder, installs the systemd unit and (only if missing) /etc/steady-walker.env, and enables
# the service. It also installs the Wi-Fi helpers (walker-wifi.service reads the SD card's wifi.txt at
# boot; `sudo walker-wifi-add.sh` adds a network over SSH) and puts the instructions file on the card if
# it has none. It does not pair the walker or start the service: see devices/pi/README.md.
set -euo pipefail

bundle="${1:-}"
here="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -z "$bundle" || ! -f "$bundle" ]]; then
  echo "Usage: sudo $0 <path to dist/walker.mjs>" >&2
  exit 2
fi
if [[ $EUID -ne 0 ]]; then
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

id -u steady >/dev/null 2>&1 || useradd --system --home-dir /var/lib/steady-walker --shell /usr/sbin/nologin steady
for group in audio dialout gpio; do
  if getent group "$group" >/dev/null; then usermod -aG "$group" steady; else echo "Note: no '$group' group on this system." >&2; fi
done

install -d -m 0755 /opt/steady-walker
install -m 0755 "$bundle" /opt/steady-walker/walker.mjs
install -d -m 0700 -o steady -g steady /var/lib/steady-walker
if [[ ! -f /etc/steady-walker.env ]]; then
  install -m 0640 -o root -g steady "$here/systemd/steady-walker.env.example" /etc/steady-walker.env
  echo "Wrote /etc/steady-walker.env from the example: edit the ALSA names and pins before starting."
fi
install -m 0644 "$here/systemd/steady-walker.service" /etc/systemd/system/steady-walker.service

# Wi-Fi on any network: wifi.txt on the card's boot partition (editable from any computer), read at boot.
install -m 0755 "$here/scripts/walker-wifi-import.sh" /opt/steady-walker/walker-wifi-import.sh
install -m 0755 "$here/scripts/walker-wifi-add.sh" /opt/steady-walker/walker-wifi-add.sh
ln -sf /opt/steady-walker/walker-wifi-add.sh /usr/local/sbin/walker-wifi-add.sh
install -m 0644 "$here/systemd/walker-wifi.service" /etc/systemd/system/walker-wifi.service
if [[ ! -d /boot/firmware ]]; then
  echo "Note: no /boot/firmware on this system, so no wifi.txt was put on the card." >&2
elif [[ ! -f /boot/firmware/wifi.txt ]]; then
  # Plain cp: the boot partition is FAT, which can't take the file modes `install` would set.
  cp "$here/systemd/wifi.txt.example" /boot/firmware/wifi.txt
  echo "Wrote /boot/firmware/wifi.txt: add Wi-Fi networks there from any computer (README, \"Wi-Fi on any network\")."
fi

systemctl daemon-reload
systemctl enable walker-wifi.service steady-walker.service
echo "Installed and enabled (not started). Next: edit /etc/steady-walker.env, pair, then sudo systemctl start steady-walker."
