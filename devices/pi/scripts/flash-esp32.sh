#!/usr/bin/env bash
# Flashes a prebuilt Sophi ESP32 image onto one board plugged into the Pi, with esptool.
# Usage, on the Pi: sudo ./flash-esp32.sh <module id> [--port <serial port>] [--images <folder>]
#   <module id>  the id the image was built with: hand-left-01, hand-right-01 or tof-front-01
#   --port       the board's port (default: the only one under /dev/serial/by-id)
#   --images     where the images are (default /opt/steady-walker/firmware); each id has its own folder
#                with bootloader.bin, partitions.bin, boot_app0.bin and firmware.bin (firmware/README.md,
#                "Build an image on a Mac, flash it from the Pi").
# Not yet run on the Pi. It writes the same four files at the same addresses as the reflash of hand-left-01
# from the Pi with esptool 5.6.0 on 2026-10-24 (firmware/README.md, bench record). Checked on a Mac with fake
# systemctl, fuser and esptool (devices/pi/test/flash-esp32.test.ts).
#
# It refuses to run while the walker service is running (the service holds every serial port open, and two
# programs on one port corrupt both), when another program holds the port, when a file is missing, and when
# firmware.bin doesn't contain the id it is being flashed as. It never stops the service itself.
set -euo pipefail

usage() {
  echo "Usage: sudo $0 <module id> [--port <serial port>] [--images <folder>]" >&2
  echo "  For example: sudo $0 hand-right-01" >&2
  exit 2
}

id="${1:-}"
[[ -n "$id" ]] || usage
shift
# The firmware's own rule for an id (firmware/lib/module/provision.h): lowercase letters, digits and dashes,
# at most 32 characters, and never "any".
if [[ ! "$id" =~ ^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$ || "$id" == "any" ]]; then
  echo "Not a module id: \"$id\"." >&2
  usage
fi
port=""
images="${WALKER_FIRMWARE_DIR:-/opt/steady-walker/firmware}"
while (( $# > 0 )); do
  case "$1" in
    --port) port="${2:-}"; [[ -n "$port" ]] || usage; shift 2 ;;
    --images) images="${2:-}"; [[ -n "$images" ]] || usage; shift 2 ;;
    *) usage ;;
  esac
done

# 1. The walker service must not be holding the ports.
if command -v systemctl >/dev/null && systemctl is-active --quiet steady-walker; then
  echo "The walker service is running and holds the serial ports. Stop it first:" >&2
  echo "  sudo systemctl stop steady-walker" >&2
  echo "then run this again, and start it afterwards: sudo systemctl start steady-walker" >&2
  exit 1
fi

# 2. The image: four files, and firmware.bin must carry this id (the build bakes it in as text).
dir="$images/$id"
for file in bootloader.bin partitions.bin boot_app0.bin firmware.bin; do
  if [[ ! -s "$dir/$file" ]]; then
    echo "Missing $dir/$file. Build the image for $id and copy it here (firmware/README.md)." >&2
    exit 1
  fi
done
if ! grep -qaF -- "$id" "$dir/firmware.bin"; then
  echo "$dir/firmware.bin doesn't contain \"$id\": it was built for another board. Rebuild it with WALKER_MODULE_ID=$id." >&2
  exit 1
fi

# 3. The port: the one given, or the only board plugged in.
serial_dir="${WALKER_SERIAL_DIR:-/dev/serial/by-id}"
if [[ -z "$port" ]]; then
  ports=()
  if [[ -d "$serial_dir" ]]; then
    for p in "$serial_dir"/*; do [[ -e "$p" ]] && ports+=("$p"); done
  fi
  if (( ${#ports[@]} == 0 )); then
    echo "No board under $serial_dir. Plug it in with a data cable (check lsusb)." >&2
    exit 1
  fi
  if (( ${#ports[@]} > 1 )); then
    echo "More than one board is plugged in; say which with --port:" >&2
    printf '  %s\n' "${ports[@]}" >&2
    exit 1
  fi
  port="${ports[0]}"
fi
if [[ ! -e "$port" ]]; then
  echo "No such port: $port" >&2
  exit 1
fi
# fuser prints the ids of processes holding the file on stdout (its exit code differs between Linux and macOS).
holders=""
if command -v fuser >/dev/null; then holders="$(fuser "$port" 2>/dev/null || true)"; fi
if [[ "$holders" =~ [0-9] ]]; then
  echo "Another program (process$holders) has $port open. Close it first." >&2
  exit 1
fi

# 4. esptool: ESPTOOL, else the copy in /opt/esptool, else one on the PATH.
esptool="${ESPTOOL:-}"
if [[ -z "$esptool" ]]; then
  for candidate in /opt/esptool/bin/esptool /opt/esptool/bin/esptool.py esptool esptool.py; do
    if command -v "$candidate" >/dev/null; then esptool="$candidate"; break; fi
  done
fi
if [[ -z "$esptool" ]]; then
  echo "esptool not found (looked in /opt/esptool/bin and on the PATH). Set ESPTOOL=<path>." >&2
  exit 1
fi

# esptool 5 spells the command write-flash; esptool 4 (PlatformIO's, or an older apt package) only write_flash.
version="$("$esptool" version 2>/dev/null | grep -oE 'v?[0-9]+\.[0-9]+' | head -n 1 || true)"
major="${version#v}"
major="${major%%.*}"
command="write-flash"
if [[ "$major" =~ ^[0-9]+$ ]] && (( major < 5 )); then command="write_flash"; fi

echo "Flashing $id from $dir onto $port with $esptool ${version:-(version unknown)}."
echo "If it can't connect, hold the board's BOOT button while it says \"Connecting...\"."
cd "$dir"
# The ESP32 Arduino layout: bootloader at 0x1000, partition table at 0x8000, boot_app0 at 0xe000, the app at 0x10000.
"$esptool" --chip esp32 --port "$port" --baud 460800 "$command" \
  0x1000 bootloader.bin 0x8000 partitions.bin 0xe000 boot_app0.bin 0x10000 firmware.bin
echo "Done. Check it said hello: sudo node /opt/steady-walker/walker.mjs check --expect $id"
echo "Then start the walker again: sudo systemctl start steady-walker"
