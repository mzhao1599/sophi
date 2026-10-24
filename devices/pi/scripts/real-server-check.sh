#!/bin/bash
# Runs the simulated walker against a real walker server on this Mac, once, and drives the parts a script
# can't: it pauses and resumes the server (offline and back) and forgets the walker (401).
# Usage: scripts/real-server-check.sh [base URL, default http://localhost:3008] [output folder]
# Start the server first, with no DATABASE_URL (in-memory store): pnpm --filter @walker/web exec next dev --port 3008
# Needs: curl, lsof, python3, and a built bundle (pnpm --filter @walker/pi bundle). Exits with the simulator's code.
set -u
BASE="${1:-http://localhost:3008}"
BASE="${BASE%/}"
OUT="${2:-$(mktemp -d "${TMPDIR:-/tmp}/walker-real-XXXXXX")}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ST="$OUT/state"; JAR="$OUT/cookies.txt"; LOG="$OUT/simulate.log"
mkdir -p "$OUT"; rm -rf "$ST" "$JAR"
# It pauses the server process on this machine, so it only ever runs against a local server.
host="$(python3 -c 'import sys,urllib.parse as u; print(u.urlparse(sys.argv[1]).hostname or "")' "$BASE")"
port="$(python3 -c 'import sys,urllib.parse as u; p=u.urlparse(sys.argv[1]); print(p.port or (443 if p.scheme=="https" else 80))' "$BASE")"
case "$host" in localhost|127.0.0.1) ;; *) echo "Only a server on this Mac (localhost or 127.0.0.1): it pauses that server's process."; exit 2 ;; esac
[ -f "$HERE/dist/walker.mjs" ] || { echo "No bundle: run pnpm --filter @walker/pi bundle first."; exit 2; }
sim=""; server=""
# However the run ends (done, failed, Ctrl-C), never leave the server paused or the simulator running.
cleanup() { [ -n "$server" ] && kill -CONT "$server" 2>/dev/null; [ -n "$sim" ] && kill "$sim" 2>/dev/null; true; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM
count() { grep -c "$1" "$LOG" 2>/dev/null || true; }
wait_for() { # pattern, how many times, seconds; gives up at once if the simulator has ended
  for _ in $(seq 1 $(( $3 * 2 ))); do
    [ "$(count "$1")" -ge "$2" ] && return 0
    kill -0 "$sim" 2>/dev/null || { sim=""; echo "the simulator ended early; see $LOG"; return 1; }
    sleep 0.5
  done
  echo "timed out waiting for: $1"; return 1
}

code="$(curl -s -c "$JAR" -X POST "$BASE/api/v1/walkers/pairing-codes" | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')" || { echo "no pairing code"; exit 1; }
node "$HERE/dist/walker.mjs" pair "$code" --server "$BASE" --name "Simulated walker" --state "$ST" || exit 1
# Plant configuration 2 "from an earlier pairing": the heartbeat's version 1 then differs, so the walker fetches it.
python3 - "$ST/configuration.json" <<'PY'
import json, sys
path = sys.argv[1]; config = json.load(open(path)); config["version"] = 2; config["cues"] = ["sound"]
json.dump(config, open(path, "w"))
PY
node "$HERE/dist/walker.mjs" simulate --server "$BASE" --state "$ST" --out "$OUT/audio" --script "$HERE/test/sim/real-server.walk" > "$LOG" 2>&1 &
sim=$!
if wait_for 'saw cue nothing_to_confirm' 1 60; then
  curl -s -b "$JAR" "$BASE/api/v1/walkers" > "$OUT/status-before.json"
  # Exactly one process listens on the port, and it is the Next server: anything else, and nothing is paused.
  listeners="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t | sort -u)"
  if [ "$(printf '%s\n' "$listeners" | grep -c .)" -ne 1 ]; then
    echo "expected one process listening on port $port, found: ${listeners:-none}"
  elif ! ps -o command= -p "$listeners" | grep -q next; then
    echo "the process on port $port isn't a Next server; not pausing it"
  else
    server="$listeners"
    kill -STOP "$server"; echo "server paused (pid $server)"
    wait_for 'saw haptic near_obstacle' 2 90
    kill -CONT "$server"; echo "server resumed"
    wait_for "back online" 1 90 && sleep 6 && curl -s -b "$JAR" "$BASE/api/v1/walkers" > "$OUT/status-after.json"
  fi
fi
device="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["device_id"])' "$ST/credential.json")"
curl -s -o /dev/null -w "forget: HTTP %{http_code}\n" -b "$JAR" -X DELETE "$BASE/api/v1/walkers/$device"
wait "$sim"; result=$?; sim=""
echo "simulate exit=$result; log and status views in $OUT"
exit "$result"
