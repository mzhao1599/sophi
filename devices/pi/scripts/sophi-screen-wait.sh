#!/usr/bin/env bash
# The walker's screen kiosk starts through this script: sophi-screen.service runs
#   sophi-screen-wait.sh /usr/bin/cage ... -- /usr/bin/chromium ... <page>
# It waits until a screen is plugged in and the page answers, then replaces itself with that command (exec).
# It is the unit's main command rather than a step before it, so the unit counts as started at once and boot
# never waits for a screen. Without a screen, or before the walker service serves its page, it just keeps
# waiting (one journal line each time what it's waiting for changes); nothing here touches the walker service.
# SOPHI_SCREEN_WAIT_SECONDS sets a time limit, after which it exits 1 (for tests; unset on the Pi).
# Run on the Pi on 2026-10-25; the owner saw the live Sophi interface.
#
# The kiosk shows only local pages: a file:// page on the Pi, or the walker service's own page on
# http://127.0.0.1. Any other address is refused, so the screen can never be pointed at a web site.
set -uo pipefail

url="${SOPHI_SCREEN_URL:-}"
limit="${SOPHI_SCREEN_WAIT_SECONDS:-}"
drm="${SOPHI_SCREEN_DRM_DIR:-/sys/class/drm}"

# The port must be digits followed by "/", so "http://127.0.0.1:x@example.com/" (a web site) is refused.
local_page='^(file:///|http://127\.0\.0\.1(:[0-9]+)?/)'
if [[ ! "$url" =~ $local_page ]]; then
  echo "SOPHI_SCREEN_URL is '$url'. The screen shows only local pages: file:///... or http://127.0.0.1:<port>/..."
  exit 1
fi

# A connected HDMI port: the kernel writes "connected" in /sys/class/drm/card*-HDMI-A-*/status.
screen_connected() {
  local f
  for f in "$drm"/card*-HDMI-A-*/status; do
    [[ -r "$f" && "$(cat "$f")" == connected ]] && return 0
  done
  return 1
}

page_answers() {
  case "$url" in
    file://*) [[ -r "${url#file://}" ]] ;;
    *) curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null ;;
  esac
}

start=$SECONDS
said=""
while true; do
  if ! screen_connected; then
    reason="no screen is connected (no HDMI port reads 'connected' in $drm)"
  elif ! page_answers; then
    reason="the page doesn't answer yet: $url"
  else
    echo "Screen connected and the page answers: starting the kiosk."
    if (( $# == 0 )); then exit 0; fi
    exec "$@"
  fi
  if [[ "$reason" != "$said" ]]; then
    echo "Waiting: $reason"
    said="$reason"
  fi
  if [[ -n "$limit" ]] && (( SECONDS - start >= limit )); then
    echo "Gave up after ${limit} s: $reason."
    exit 1
  fi
  sleep 2
done
