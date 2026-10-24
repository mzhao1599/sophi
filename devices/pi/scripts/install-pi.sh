#!/usr/bin/env bash
# Installs Steady's walker service on a Raspberry Pi. NOT YET RUN ON A PI.
# Usage, on the Pi, from a copy of devices/pi: sudo ./scripts/install-pi.sh dist/walker.mjs
# What it does: creates the `steady` system user, copies the bundle to /opt/steady-walker, creates the
# 0700 state folder, installs the systemd unit and (only if missing) /etc/steady-walker.env, and enables
# the service. It does not pair the walker or start the service: see devices/pi/README.md.
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
systemctl daemon-reload
systemctl enable steady-walker.service
echo "Installed and enabled (not started). Next: edit /etc/steady-walker.env, pair, then sudo systemctl start steady-walker."
