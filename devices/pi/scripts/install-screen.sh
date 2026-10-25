#!/usr/bin/env bash
# Sets up the walker's 800x480 HDMI touch screen (README, "The screen"). Run by `install-pi.sh --screen`
# after the walker service is installed and enabled, or on its own to (re)do just the screen:
#   sudo ./scripts/install-screen.sh [boot folder, default /boot/firmware]
# It sets the display settings (scripts/screen-display.sh, which backs up each file it changes), creates the
# `sophi-screen` user, installs its PAM file, the placeholder page, the wait script and the sophi-screen unit,
# and enables the unit. It stops at the first failure; its last line of output is then the reason, which
# install-pi.sh prints as "Screen not installed: <reason>". Run on the Pi on 2026-10-25.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
boot="${1:-/boot/firmware}"
bin_dir="${WALKER_SCREEN_BIN_DIR:-/usr/bin}" # where the unit runs cage and chromium from (changed only by tests)

if [[ "$(id -u)" != 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi
for tool in cage chromium; do
  if [[ ! -x "$bin_dir/$tool" ]]; then
    echo "No $bin_dir/$tool, which sophi-screen.service runs. Install with: sudo apt install cage chromium curl" >&2
    exit 1
  fi
done
if ! command -v curl >/dev/null; then
  echo "No curl, which the screen's wait script uses. Install with: sudo apt install curl" >&2
  exit 1
fi
if [[ ! -d "$boot" ]]; then
  echo "No $boot folder (the SD card's boot partition), so the display settings can't be set." >&2
  exit 1
fi

# Display settings first: if they can't be set, nothing else is installed.
"$here/scripts/screen-display.sh" "$boot"
# Its own user, so the browser can't read the walker's credential. Home is the unit's /run folder.
id -u sophi-screen >/dev/null 2>&1 || useradd --system --home-dir /run/sophi-screen --no-create-home --shell /usr/sbin/nologin sophi-screen
for group in video render input; do
  if getent group "$group" >/dev/null; then usermod -aG "$group" sophi-screen; else echo "Note: no '$group' group on this system." >&2; fi
done
install -d -m 0755 /opt/steady-walker/screen
install -m 0644 "$here/screen/placeholder.html" /opt/steady-walker/screen/placeholder.html
install -m 0755 "$here/scripts/sophi-screen-wait.sh" /opt/steady-walker/screen/sophi-screen-wait.sh
install -m 0644 "$here/systemd/sophi-screen.pam" /etc/pam.d/sophi-screen
install -m 0644 "$here/systemd/sophi-screen.service" /etc/systemd/system/sophi-screen.service
systemctl daemon-reload
systemctl enable sophi-screen.service
echo "Screen: sophi-screen enabled. Reboot (sudo systemctl reboot) to apply the display settings and start it."
